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

**Étape 3 : analyse**
- `POST /api/projects/:id/analyze` : file d'attente dans le processus (une analyse à la fois), étapes publiées dans `analysis.stage`, reprise propre après un redémarrage (`ANALYSIS_INTERRUPTED`), plafond quotidien (`MAX_ANALYSES_PER_DAY`).
- Audio mono 16 kHz → Groq Whisper (français imposé, segments sans parole écartés) ; 12 images en planche contact 4 × 3 horodatée ; OpenRouter avec schéma JSON imposé, modèle de secours et vérification réelle de la prise en charge des images, repli sur le texte seul ; Pixabay (cache 24 h, domaines pixabay.com uniquement).
- Suggestions normalisées selon le contrat (bornes, durées 1 à 10 s, sans chevauchement, 8 au plus).
- Fournisseurs injectables dans les tests ; `PROVIDER_MODE=mock` pour les tests hors ligne d'OpenCode, refusé en production.
- Vérifié en réel le 18/11 : vidéo parlée de 34 s analysée en 31 s, 2 suggestions avec 4 vidéos Pixabay chacune.

**Étape 4 : édition des B-rolls**
- `PATCH /api/projects/:id/timeline` : accepter, refuser, mettre de côté, remplacer la vidéo, déplacer, ajuster, cadrer ; tout ou rien, révision vérifiée, règles du contrat (bornes, 1 à 10 s, durée ≤ vidéo choisie, aucun chevauchement entre B-rolls montés).
- Corps validé strictement (`utils/validation.ts`) : un champ en lecture seule est refusé.

**Budget zéro (D-14)** : chaîne de modèles OpenRouter gratuits (`OPENROUTER_FALLBACK_MODEL` accepte une liste), modèles disparus ignorés, message clair quand le quota gratuit du jour est atteint.

**Étape 5 : export**
- `POST /api/projects/:id/render` : job en `preparing` (création conditionnelle : un seul export actif par projet), récupération des B-rolls retenus (réutilisés, téléchargés depuis Pixabay sous contrôle, ou fabriqués en mode simulation), durée réelle mesurée, puis `queued` pour le worker de Codex. Reprise propre après un redémarrage (`RENDER_INTERRUPTED`).
- `GET /api/projects/:id/render/status` et `GET /api/projects/:id/download` (pièce jointe, requêtes Range).
- **Vérifié de bout en bout le 19/11** avec le worker de Codex : vidéo parlée de 34 s → analyse (modèles gratuits) → export → MP4 H.264/AAC 1280×720 de 33,6 s, B-roll visible au bon moment, son d'origine identique (−20,4 dB moyen dans la source et l'export).

## Pas encore fait

Suppression de projet (D-11) et connexion Google (D-04), reportées. Pistes de fluidité (P1) : télécharger des versions Pixabay à la taille de l'export, préparer les B-rolls dès la fin de l'analyse.

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
    analysis.service.ts         file d'analyse et enchaînement des étapes
    transcription.service.ts    extraction audio et normalisation de la transcription
    keyframes.service.ts        images clés et planche contact
    vision-analysis.service.ts  consignes au modèle, repli texte seul, normalisation des suggestions
    broll-search.service.ts     candidats B-roll par suggestion
    timeline.service.ts         règle d'inclusion et calcul de project.timeline
    render-state.ts             état du rendu à partir de render_jobs
  providers/                    Groq, OpenRouter, Pixabay, simulation (mode mock) et appel HTTP commun
  media/ffprobe.ts, ffmpeg.ts   FFmpeg et ffprobe sans shell, protocole « file » seul
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
