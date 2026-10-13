# Mise en ligne publique — Voidloop's Studio

Le site utilise maintenant une API Node sur Render et Supabase pour conserver l’événement, les annonces, les commentaires, les statistiques et les vidéos entre les appareils. Les identifiants privés restent dans les variables d’environnement Render.

## 1. Préparer Supabase

1. Crée un projet sur [Supabase](https://supabase.com/dashboard).
2. Dans **SQL Editor**, exécute le contenu de `supabase/migrations/001_initial.sql`.
3. Dans **Project Settings → API Keys**, copie l’URL du projet et la clé **Secret** (`sb_secret_…`). Cette clé serveur ne doit jamais être placée dans `index.html`, `script.js`, GitHub ou une variable publique. L’ancienne clé `service_role` fonctionne aussi si ton projet ne propose pas encore les nouvelles clés.
4. Le SQL crée le bucket public `event-media`. Les vidéos publiées seront visibles par toute personne visitant le site. Le plafond initial est de 2 Go par fichier ; ajuste-le dans les réglages Storage si ton forfait le permet.

## 2. Préparer le mot de passe staff

Dans le dossier du projet, exécute `npm install`, puis `npm run hash-password`. Saisis un nouveau mot de passe staff d’au moins 16 caractères et garde le hash affiché. Le mot de passe lui-même n’est ni stocké ni publié par le site. La connexion staff attend 5 secondes après chaque erreur et bloque les essais suivants pendant cette période.

## 3. Publier le code sur GitHub

Crée un dépôt GitHub privé ou public, puis ajoute et pousse les fichiers du projet. Ne pousse jamais `.env`, une clé Supabase, un hash de mot de passe ou un fichier vidéo. `.gitignore` exclut ces fichiers, notamment `Content.mp4`.

Pour un dépôt neuf, dans PowerShell, depuis ce dossier :

```powershell
git init
git add .
git commit -m "Préparer le site Voidloop pour Render et Supabase"
git branch -M main
git remote add origin https://github.com/TON-COMPTE/NOM-DU-DEPOT.git
git push -u origin main
```

## 4. Créer le service Render

Dans Render, sélectionne **New → Blueprint** et connecte le dépôt. Render lit `render.yaml` et crée un service Node public avec déploiement automatique à chaque push sur la branche connectée. Sinon, crée un **Web Service** avec `npm ci` comme commande de build et `npm start` comme commande de démarrage.

Dans **Environment**, définis `SUPABASE_URL`, `SUPABASE_SECRET_KEY` et `STAFF_PASSWORD_HASH`. Render génère `SESSION_SECRET` et `ANALYTICS_PEPPER` via le Blueprint. Enregistre puis déploie. L’adresse publique `*.onrender.com` apparaît dans la page du service.

Si tu crées le Web Service manuellement sans Blueprint, ajoute aussi `NODE_ENV=production`, `SESSION_SECRET` et `ANALYTICS_PEPPER`. Génère chaque secret avec `node -p "require('node:crypto').randomBytes(32).toString('hex')"` puis colle les valeurs uniquement dans Render.

## Sécurité mise en place

- Le mot de passe staff est vérifié côté serveur avec bcrypt; aucun mot de passe ni hash n’est dans le JavaScript public.
- Session staff dans un cookie `HttpOnly`, `Secure` en production et `SameSite=Strict`; les actions de modification exigent cette session et une origine de même site.
- Délai de 5 secondes après un mauvais mot de passe, avec cooldown par adresse IP.
- Les accès Postgres directs des rôles `anon` et `authenticated` sont révoqués par RLS. Seul le serveur Render utilise la clé service-role.
- Les entrées sont limitées/validées côté serveur. Les requêtes passent par le client Supabase avec des paramètres séparés; aucun SQL n’est construit à partir du texte envoyé par un visiteur.
- Les commentaires sont acceptés uniquement pendant un direct, limités en longueur et en fréquence. Les identifiants visiteurs sont hachés avec un secret serveur.
- Les uploads utilisent un lien signé temporaire délivré au staff connecté; le navigateur envoie ensuite le fichier directement dans Supabase Storage.

Après avoir changé le schéma SQL ou les variables Render, redéploie le service. Les services Render gratuits peuvent s’endormir après une période sans trafic et le premier chargement suivant peut être plus lent.

Le déploiement démarre avec une base vide. Les événements et annonces qui n’existaient que dans le `localStorage` de l’ancien site ne migrent pas automatiquement ; republie-les depuis le panel staff après le déploiement et téléverse de nouveau les vidéos.
