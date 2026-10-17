"use strict";

require("dotenv").config?.();

const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const cookieSession = require("cookie-session");
const bcrypt = require("bcryptjs");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const port = Number(process.env.PORT) || 10000;
const isProduction = process.env.NODE_ENV === "production";
const BUCKET = "event-media";
const DEFAULT_STATE = { status: "upcoming", title: "", source: "", replays: [] };
const loginCooldowns = new Map();
const commentTimes = new Map();
const heartbeatTimes = new Map();
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const sessionSecret = process.env.SESSION_SECRET;
const analyticsPepper = process.env.ANALYTICS_PEPPER;

let supabase;
if (supabaseUrl && serviceKey) {
  supabase = createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false }
  });
}

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "https://www.youtube.com"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https://i.ytimg.com"],
      mediaSrc: ["'self'", "https://*.supabase.co", "https://*.storage.supabase.co", "blob:"],
      frameSrc: ["'self'", "https://www.youtube.com", "https://www.youtube-nocookie.com"],
      connectSrc: ["'self'", "https://*.supabase.co", "https://*.storage.supabase.co"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" }
}));
app.use(express.json({ limit: "9mb", strict: true }));
app.use(cookieSession({
  name: "voidloop_staff",
  keys: [sessionSecret || "development-only-secret-change-before-deploy"],
  httpOnly: true,
  secure: isProduction,
  sameSite: "strict",
  maxAge: 365 * 24 * 60 * 60 * 1000
}));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
function requireSupabase(_req, res, next) {
  if (!supabase) return res.status(503).json({ error: "Le serveur Supabase n’est pas configuré." });
  if (!analyticsPepper) return res.status(503).json({ error: "La configuration serveur est incomplète." });
  next();
}
function requireStaff(req, res, next) {
  if (req.session?.staff === true && Date.now() - Number(req.session.issuedAt || 0) < 8 * 60 * 60 * 1000) return next();
  res.status(401).json({ error: "Connexion staff requise." });
}
function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  if (!origin) return res.status(403).json({ error: "Origine de requête manquante." });
  let expected;
  try { expected = new URL(`${req.protocol}://${req.get("host")}`).origin; }
  catch { return res.status(403).json({ error: "Origine invalide." }); }
  if (origin !== expected) return res.status(403).json({ error: "Origine refusée." });
  next();
}
function readText(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function readImage(value) {
  if (value === "") return "";
  if (typeof value !== "string" || value.length > 3_500_000) return null;
  return /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ? value : null;
}
function normalizeSchedule(input) {
  if (input == null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) return null;
  const title = readText(input.title, 100);
  const description = readText(input.description, 500);
  const date = typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : "";
  const time = typeof input.time === "string" && /^\d{2}:\d{2}$/.test(input.time) ? input.time : "";
  const color = typeof input.color === "string" && /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : "#5c91cf";
  const image = readImage(input.image || "");
  if (!title || !description || !date || !time || image === null) return null;
  return { title, description, date, time, color, image };
}
function normalizeState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (!["upcoming", "live", "replay"].includes(input.status)) return null;
  const title = readText(input.title, 100);
  const source = typeof input.source === "string" ? input.source.slice(0, 2000) : "";
  if (source && !/^(?:youtube:[A-Za-z0-9_-]{11}|supabase:events\/[a-f0-9-]{36}\.mp4|https:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/public\/event-media\/events\/[a-f0-9-]{36}\.mp4)$/i.test(source)) return null;
  const result = { status: input.status, title, source, replays: [] };
  if (input.startedAt && typeof input.startedAt === "string" && Number.isFinite(Date.parse(input.startedAt))) result.startedAt = new Date(input.startedAt).toISOString();
  if (input.status === "live" && (!result.startedAt || !source)) return null;
  if (input.schedule !== undefined) {
    const schedule = normalizeSchedule(input.schedule);
    if (!schedule) return null;
    result.schedule = schedule;
  }
  if (Array.isArray(input.replays)) {
    result.replays = input.replays.slice(0, 50).map(item => {
      if (!item || typeof item !== "object") return null;
      const replaySource = typeof item.source === "string" ? item.source.slice(0, 2000) : "";
      if (!/^(?:youtube:[A-Za-z0-9_-]{11}|supabase:events\/[a-f0-9-]{36}\.mp4)$/i.test(replaySource)) return null;
      const endedAt = typeof item.endedAt === "string" && Number.isFinite(Date.parse(item.endedAt)) ? new Date(item.endedAt).toISOString() : "";
      return endedAt ? { title: readText(item.title, 100), source: replaySource, endedAt } : null;
    });
    if (result.replays.some(item => item === null)) return null;
  }
  return result;
}
function normalizeAnnouncements(input) {
  if (!Array.isArray(input) || input.length > 50) return null;
  const result = [];
  for (const item of input) {
    if (!item || typeof item !== "object") return null;
    const title = readText(item.title, 100), description = readText(item.description, 500);
    const image = readImage(item.image);
    const color = typeof item.color === "string" && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : null;
    const createdAt = typeof item.createdAt === "string" && Number.isFinite(Date.parse(item.createdAt)) ? new Date(item.createdAt).toISOString() : new Date().toISOString();
    if (!title || !description || !image || !color) return null;
    result.push({ title, description, image, color, createdAt });
  }
  return result;
}
function visitorHash(req) {
  if (!req.session.visitorId) req.session.visitorId = crypto.randomUUID();
  return crypto.createHmac("sha256", analyticsPepper).update(req.session.visitorId).digest("hex");
}
async function readContent() {
  const { data, error } = await supabase.from("site_content").select("event_state,announcements,upload").eq("singleton", true).single();
  if (error) throw error;
  return data;
}
async function readComments() {
  const { data, error } = await supabase.from("live_comments").select("name,body,created_at").order("created_at", { ascending: false }).limit(100);
  if (error) throw error;
  return (data || []).reverse().map(row => ({ name: row.name, text: row.body, createdAt: row.created_at }));
}
async function publicSnapshot() {
  const [content, comments] = await Promise.all([readContent(), readComments()]);
  return {
    state: content.event_state || DEFAULT_STATE,
    announcements: content.announcements || [],
    comments,
    upload: content.upload || null,
    storageBase: `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/`,
    serverNow: Date.now()
  };
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/bootstrap", requireSupabase, asyncRoute(async (_req, res) => res.json(await publicSnapshot())));
app.get("/api/live", requireSupabase, asyncRoute(async (_req, res) => res.json(await publicSnapshot())));
app.get("/api/admin/session", (_req, res) => res.json({ authenticated: _req.session?.staff === true && Date.now() - Number(_req.session.issuedAt || 0) < 8 * 60 * 60 * 1000 }));

app.post("/api/admin/login", requireSameOrigin, asyncRoute(async (req, res) => {
  if (!process.env.STAFF_PASSWORD_HASH || !sessionSecret || sessionSecret.length < 32) return res.status(503).json({ error: "La connexion staff n’est pas configurée." });
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const blockedUntil = loginCooldowns.get(ip) || 0;
  if (blockedUntil > Date.now()) return res.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques secondes.", retryAfter: Math.ceil((blockedUntil - Date.now()) / 1000) });
  loginCooldowns.set(ip, Date.now() + 5000);
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  let valid = false;
  try { valid = password.length > 0 && password.length <= 256 && await bcrypt.compare(password, process.env.STAFF_PASSWORD_HASH); }
  catch { return res.status(503).json({ error: "La vérification du compte staff a échoué." }); }
  if (!valid) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    return res.status(401).json({ error: "Mot de passe incorrect. La connexion est bloquée pendant 5 secondes." });
  }
  loginCooldowns.delete(ip);
  req.session = { staff: true, issuedAt: Date.now(), visitorId: req.session?.visitorId || crypto.randomUUID() };
  res.json({ authenticated: true });
}));
app.post("/api/admin/logout", requireSameOrigin, (req, res) => { const visitorId = req.session?.visitorId; req.session = visitorId ? { visitorId } : null; res.json({ ok: true }); });

app.put("/api/admin/state", requireSupabase, requireSameOrigin, requireStaff, asyncRoute(async (req, res) => {
  const state = normalizeState(req.body?.state);
  if (!state) return res.status(400).json({ error: "Les informations de l’événement sont invalides." });
  const previous = await readContent();
  if (state.status === "live" && previous.event_state?.status !== "live") {
    state.startedAt = new Date().toISOString();
    const { error: resetError } = await supabase.from("live_comments").delete().gte("created_at", "1970-01-01T00:00:00.000Z");
    if (resetError) throw resetError;
  }
  const { error } = await supabase.from("site_content").update({ event_state: state, updated_at: new Date().toISOString() }).eq("singleton", true);
  if (error) throw error;
  res.json({ ok: true });
}));
app.put("/api/admin/news", requireSupabase, requireSameOrigin, requireStaff, asyncRoute(async (req, res) => {
  const announcements = normalizeAnnouncements(req.body?.announcements);
  if (!announcements) return res.status(400).json({ error: "Les nouveautés envoyées sont invalides." });
  const { error } = await supabase.from("site_content").update({ announcements, updated_at: new Date().toISOString() }).eq("singleton", true);
  if (error) throw error;
  res.json({ ok: true });
}));
app.put("/api/admin/upload-status", requireSupabase, requireSameOrigin, requireStaff, asyncRoute(async (req, res) => {
  const value = req.body?.upload;
  let upload = null;
  if (value && ["reading", "storing"].includes(value.status)) {
    const total = Number(value.total), loaded = Number(value.loaded), percent = Number(value.percent);
    if (!Number.isFinite(total) || total < 1 || total > 2_147_483_648 || !Number.isFinite(loaded) || !Number.isFinite(percent)) return res.status(400).json({ error: "Progression de transfert invalide." });
    upload = { id: readText(value.id, 80), status: value.status, name: readText(value.name, 180), total, loaded: Math.max(0, Math.min(total, loaded)), percent: Math.max(0, Math.min(99, percent)), updatedAt: new Date().toISOString() };
  }
  const { error } = await supabase.from("site_content").update({ upload, updated_at: new Date().toISOString() }).eq("singleton", true);
  if (error) throw error;
  res.json({ ok: true });
}));
app.post("/api/admin/upload-link", requireSupabase, requireSameOrigin, requireStaff, asyncRoute(async (req, res) => {
  const name = readText(req.body?.name, 180);
  const size = Number(req.body?.size);
  if (!/\.mp4$/i.test(name) || !Number.isSafeInteger(size) || size < 1 || size > 2_147_483_648) return res.status(400).json({ error: "Choisis un fichier MP4 de 2 Go maximum." });
  const filePath = `events/${crypto.randomUUID()}.mp4`;
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(filePath, { upsert: false });
  if (error) throw error;
  if (!data?.token || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(data.token) || data.path !== filePath) {
    console.error("Supabase returned an invalid signed upload link.");
    return res.status(502).json({ error: "Supabase n’a pas fourni de lien d’envoi vidéo valide. Réessaie dans un instant." });
  }
  res.json({ path: data.path || filePath, token: data.token, signedUrl: data.signedUrl, publicUrl: `${supabaseUrl.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${filePath}` });
}));
app.delete("/api/admin/video", requireSupabase, requireSameOrigin, requireStaff, asyncRoute(async (req, res) => {
  const filePath = readText(req.body?.path, 100);
  if (!/^events\/[a-f0-9-]{36}\.mp4$/i.test(filePath)) return res.status(400).json({ error: "Fichier vidéo invalide." });
  const { error } = await supabase.storage.from(BUCKET).remove([filePath]);
  if (error) throw error;
  res.json({ ok: true });
}));

app.post("/api/comments", requireSupabase, requireSameOrigin, asyncRoute(async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const last = commentTimes.get(ip) || 0;
  if (Date.now() - last < 1500) return res.status(429).json({ error: "Attends un instant avant d’envoyer un autre commentaire." });
  const name = readText(req.body?.name, 24) || "Invité";
  const body = readText(req.body?.text, 300);
  if (!body) return res.status(400).json({ error: "Le commentaire est vide." });
  const content = await readContent();
  if (content.event_state?.status !== "live") return res.status(409).json({ error: "Les commentaires sont fermés hors direct." });
  commentTimes.set(ip, Date.now());
  const { error } = await supabase.from("live_comments").insert({ name, body });
  if (error) throw error;
  await supabase.from("live_comments").delete().lt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  res.status(201).json({ ok: true });
}));

app.post("/api/heartbeat", requireSupabase, requireSameOrigin, asyncRoute(async (req, res) => {
  const hash = visitorHash(req);
  const last = heartbeatTimes.get(hash) || 0;
  if (Date.now() - last < 1500) return res.json({ ok: true });
  heartbeatTimes.set(hash, Date.now());
  const { error } = await supabase.rpc(req.body?.visit === true ? "record_site_visit" : "record_site_heartbeat", { p_visitor_hash: hash });
  if (error) throw error;
  res.json({ ok: true });
}));
app.get("/api/analytics", requireSupabase, requireStaff, asyncRoute(async (_req, res) => {
  const { data, error } = await supabase.rpc("get_site_analytics");
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  res.json({ visits: Number(row?.visits) || 0, visitors: Number(row?.visitors) || 0, online: Number(row?.online) || 0, updatedAt: new Date().toISOString() });
}));

app.use("/Content.mp4", (_req, res) => res.sendStatus(404));

app.use(express.static(path.join(__dirname), {
  index: "index.html",
  dotfiles: "ignore",
  etag: true,
  maxAge: isProduction ? "1h" : 0,
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/.test(filePath)) res.setHeader("Cache-Control", "no-cache");
    if (path.basename(filePath).toLowerCase() === "content.mp4") res.status(404);
  }
}));

app.use((err, _req, res, _next) => {
  console.error("Request failed:", err?.message || "unknown error");
  if (res.headersSent) return;
  const code = Number(err?.status) >= 400 && Number(err?.status) < 500 ? Number(err.status) : 500;
  res.status(code).json({ error: code === 500 ? "Erreur serveur. Réessaie dans un instant." : "Requête invalide." });
});

setInterval(() => {
  const now = Date.now();
  for (const [key, until] of loginCooldowns) if (until < now) loginCooldowns.delete(key);
  for (const [key, at] of commentTimes) if (at < now - 60_000) commentTimes.delete(key);
  for (const [key, at] of heartbeatTimes) if (at < now - 60_000) heartbeatTimes.delete(key);
}, 60_000).unref();

app.listen(port, "0.0.0.0", () => {
  console.log(`Voidloop event server listening on 0.0.0.0:${port}`);
  if (!supabase || !sessionSecret || sessionSecret.length < 32 || !analyticsPepper) console.warn("Configuration Render incomplète : renseigne les variables Supabase et les secrets serveur.");
});
