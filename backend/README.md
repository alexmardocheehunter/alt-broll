# backend/ : API ALT B-ROLL (Claude Code)

Node.js 24 + TypeScript exécuté nativement (sans compilation) + Express 5 + SQLite intégré à Node (`node:sqlite`).

## Prérequis

- Node.js 24 ou plus récent (`node --version`).
- FFmpeg et ffprobe dans le PATH, ou chemins renseignés dans `FFMPEG_PATH` / `FFPROBE_PATH`.

## Installation

```powershell
# à la racine du projet
Copy-Item .env.example .env   # puis renseigner les clés (jamais dans Git)
cd backend
npm install
```

Sans `.env`, le serveur démarre avec les valeurs par défaut (développement, sans fournisseur configuré).

## Commandes

| Commande | Effet |
|---|---|
| `npm run dev` | Démarre l'API et la relance à chaque modification (http://127.0.0.1:3000) |
| `npm start` | Démarre l'API ; avec `NODE_ENV=production`, les clés et FFmpeg sont obligatoires |
| `npm run typecheck` | Vérifie les types du backend et du contrat partagé |
| `npm run build` | Même vérification : il n'y a pas d'artefact à produire, Node 24 exécute le TypeScript |
| `npm test` | Lance les tests (`node:test`), sans appel à Groq, OpenRouter ou Pixabay ; les tests d'import génèrent leurs vidéos avec FFmpeg et sont sautés s'il est absent |

Vérification rapide : http://127.0.0.1:3000/api/health doit répondre `"status":"ok"`.

## En place

**Étape 1 : socle**
- Configuration validée au démarrage ([src/config/env.ts](src/config/env.ts)) : un seul `.env` à la racine, chemins résolus depuis la racine, clés obligatoires uniquement en production, aucune valeur secrète affichée en cas d'erreur.
- Logs JSON, une ligne par événement, avec masquage des champs sensibles et des clés glissées dans les URL ; identifiant `X-Request-Id` par requête.
- Erreurs structurées `{ error: { code, stage, message, retryable }, requestId }`, sans stack trace ni chemin serveur.
- SQLite initialisé automatiquement (WAL, migrations versionnées) : tables `projects` et `render_jobs` (schéma du contrat).
- CORS limité à `FRONTEND_ORIGIN` ; `GET /api/health`, `GET /api/config`.

**Étape 2 : projets et import**
- `POST /api/projects`, `GET /api/projects/:id`, `…/status`, `…/suggestions` ; écritures protégées contre les modifications concurrentes (`revision`).
- `POST /api/projects/:id/upload` : contrôle du nom et du type annoncés, réception dans un dossier temporaire, signature MP4, ffprobe (durée, dimensions avec rotation, cadence, codec H.264, audio), rangement sous un nom généré par le serveur. Fichier temporaire supprimé dans tous les cas ; envois abandonnés nettoyés au démarrage.
- `GET /api/projects/:id/media/source` : vidéo source pour le lecteur, requêtes `Range` comprises.
- Stockage isolé par projet : tout chemin est calculé par le serveur et vérifié (motif du contrat + confinement au dossier du projet).
- `render` est calculé à partir du dernier job écrit par le worker dans `render_jobs` : progression à 1 une fois terminé, à 0 tant que le rendu n'a pas commencé, codes d'erreur limités à `RENDER_*` (corrections BUG-QA-001, QA-OBS-002 et QA-OBS-003 du rapport QA).
- Limite de débit par adresse IP sur la création et l'import (`RATE_LIMIT_WRITES_PER_HOUR`) ; `TRUST_PROXY=loopback` derrière un tunnel local (QA-OBS-005).

## Pas encore fait

Transcription Groq, images clés, analyse OpenRouter, recherche Pixabay, modification de la timeline, création des jobs de rendu, téléchargement du résultat, contrôle d'accès (D-04). Rien n'est simulé : ces routes n'existent pas encore et répondent 404 ([docs/API.md](../docs/API.md)).

## Structure

```text
src/
  server.ts                     point d'entrée : .env, configuration, stockage, base, écoute HTTP, arrêt propre
  app.ts                        assemblage : middlewares, services, routes, erreurs
  contract.ts                   ré-export de shared/contract.ts (un seul chemin à maintenir)
  config/env.ts                 variables d'environnement validées (zod)
  db/database.ts                connexion SQLite et migrations
  repositories/
    project.repository.ts       table projects (document JSON + révision)
    job.repository.ts           lecture de render_jobs
  services/
    project.service.ts          projets : création, lecture, enregistrement avec contrôle de révision
    upload.service.ts           import : réception, vérifications, rangement
    timeline.service.ts         règle d'inclusion et calcul de project.timeline
    render-state.ts             état du rendu à partir de render_jobs
  media/ffprobe.ts              lecture des métadonnées vidéo (sans shell, protocole « file » seul)
  storage/local-storage.ts      chemins des projets et nettoyage des envois
  routes/
    system.routes.ts            /api/health, /api/config
    projects.routes.ts          projets et import
    media.routes.ts             vidéo source
  utils/                        erreurs, logs, identifiant de requête, limite de débit, détection de FFmpeg
test/                           tests du backend (les tests transverses sont dans tests/, OpenCode)
data/                           base SQLite locale, ignorée par Git
```

Ajouts par rapport à l'arborescence indicative du document : `db/`, `media/`, `services/render-state.ts`.
