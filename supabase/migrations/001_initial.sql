create extension if not exists pgcrypto with schema extensions;

create table if not exists public.site_content (
  singleton boolean primary key default true check (singleton),
  event_state jsonb not null default '{"status":"upcoming","title":"","source":"","replays":[]}'::jsonb,
  announcements jsonb not null default '[]'::jsonb,
  upload jsonb,
  updated_at timestamptz not null default now()
);

insert into public.site_content (singleton) values (true) on conflict (singleton) do nothing;

create table if not exists public.live_comments (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 24),
  body text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);
create index if not exists live_comments_created_at_idx on public.live_comments (created_at desc);

create table if not exists public.site_visitors (
  visitor_hash text primary key check (char_length(visitor_hash) = 64),
  visits bigint not null default 1 check (visits > 0),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists site_visitors_last_seen_idx on public.site_visitors (last_seen desc);

alter table public.site_content enable row level security;
alter table public.live_comments enable row level security;
alter table public.site_visitors enable row level security;
revoke all on public.site_content, public.live_comments, public.site_visitors from anon, authenticated;
grant all on public.site_content, public.live_comments, public.site_visitors to service_role;

create or replace function public.record_site_visit(p_visitor_hash text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_visitor_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid visitor key'; end if;
  insert into public.site_visitors (visitor_hash, visits, first_seen, last_seen)
  values (p_visitor_hash, 1, now(), now())
  on conflict (visitor_hash) do update set visits = public.site_visitors.visits + 1, last_seen = now();
end;
$$;

create or replace function public.record_site_heartbeat(p_visitor_hash text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_visitor_hash !~ '^[a-f0-9]{64}$' then raise exception 'invalid visitor key'; end if;
  insert into public.site_visitors (visitor_hash, visits, first_seen, last_seen)
  values (p_visitor_hash, 1, now(), now())
  on conflict (visitor_hash) do update set last_seen = now();
end;
$$;

create or replace function public.get_site_analytics()
returns table (visits bigint, visitors bigint, online bigint)
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(v.visits), 0)::bigint,
         count(*)::bigint,
         count(*) filter (where v.last_seen > now() - interval '20 seconds')::bigint
  from public.site_visitors v;
$$;

revoke all on function public.record_site_visit(text), public.record_site_heartbeat(text), public.get_site_analytics() from public, anon, authenticated;
grant execute on function public.record_site_visit(text), public.record_site_heartbeat(text), public.get_site_analytics() to service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('event-media', 'event-media', true, 2147483648, array['video/mp4', 'image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = 2147483648,
  allowed_mime_types = array['video/mp4', 'image/jpeg', 'image/png', 'image/webp'];

-- No anon/authenticated Storage write policy is created. Only the server's
-- service-role client can create signed staff upload links or delete files.
