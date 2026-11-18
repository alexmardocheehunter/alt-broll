# shared/ : contrat commun ALT B-ROLL

> **Statut : proposition v1 du 18/11/2026, préparée par Claude Code, à valider par Alex** (propriétaire du dossier).
> Toute modification se propose avant d'être appliquée (PROJECT_MASTER §6 et §11). Points ouverts : [docs/DECISIONS.md](../docs/DECISIONS.md).

| Fichier | Rôle |
|---|---|
| [contract.ts](contract.ts) | Types, constantes, codes d'erreur, schéma SQLite et requêtes du protocole de rendu. Aucune dépendance. |
| [package.json](package.json) | Déclare le dossier en module ES (requis par Node et par TypeScript `nodenext`). |
| [examples/project.example.json](examples/project.example.json) | Réponse `GET /api/projects/:id` **fictive** (URL en `example.com`), vérifiée par `tsc` contre le contrat à sa création. Sert à maquetter le frontend. |

## Importer le contrat

Node.js 24 exécute le TypeScript directement, sans compilation :

```ts
// depuis backend/src/… ou renderer/src/…
import { RENDER_JOB_SQL, type RenderJobPayload, type RenderJobRow } from '../../shared/contract.ts';
```

Options `tsconfig.json` nécessaires : `"module": "nodenext"`, `"allowImportingTsExtensions": true`, `"noEmit": true`, `"verbatimModuleSyntax": true`, `"erasableSyntaxOnly": true` (modèle : [backend/tsconfig.json](../backend/tsconfig.json)). Avec `tsx`, l'import fonctionne aussi tel quel.

Le frontend (JavaScript) ne l'importe pas : il s'en sert comme spécification, avec l'exemple JSON et `GET /api/config`.

## Points clés

1. **Temps** en secondes sur l'axe de la vidéo source, intervalles `[début, fin[`, arrondis à la milliseconde.
2. **Source de vérité** : le projet, stocké en SQLite. `timeline`, `render` et `urls` sont calculés par le backend et jamais envoyés par le client.
3. **Règle d'inclusion** (preview = export, proposition D-06) : un B-roll est monté si `enabled && status !== 'rejected' && selectedCandidateId !== null`. Le frontend utilise `project.timeline.segments` pour la preview ; le worker reçoit les mêmes segments.
4. **Statuts** d'analyse et de rendu indépendants. **Erreurs** `{ code, stage, message, retryable }`, sans secret ni chemin serveur.
5. **Révision** : chaque écriture incrémente `revision`. `PATCH timeline` et `POST render` envoient la révision connue, sinon `409 REVISION_CONFLICT`.

## Protocole des jobs de rendu (backend ↔ worker)

Base commune : `DATABASE_PATH`, lue dans le même `.env` à la racine. Le backend crée la table au démarrage avec `RENDER_JOBS_TABLE_SQL` (idempotent : le worker et les tests peuvent l'exécuter aussi).

| Transition | Écrite par | Requête |
|---|---|---|
| création → `preparing` | backend (`POST /render`) | insertion (backend) |
| `preparing` → `queued` | backend, une fois les B-rolls téléchargés et vérifiés | backend |
| `preparing` → `failed` | backend (`RENDER_MEDIA_DOWNLOAD_FAILED`, `RENDER_INTERRUPTED`) | backend |
| `queued` → `rendering` | worker | `RENDER_JOB_SQL.claimNext`, dans `BEGIN IMMEDIATE … COMMIT` |
| progression + bail | worker, toutes les 15 s | `heartbeat` |
| `rendering` → `completed` | worker, **après** validation ffprobe | `complete` |
| `rendering` → `failed` | worker | `fail` (code `RENDER_*`, message en français) |
| bail expiré → `queued` ou `failed` | worker, au démarrage et avant chaque prise | `recoverStale` |

- 0 ligne modifiée par `heartbeat`, `complete` ou `fail` : le worker ne détient plus le job et arrête le rendu.
- `claimNext` applique `MAX_CONCURRENT_RENDERS` dans la base elle-même, même si deux workers sont lancés par erreur.
- Le worker ne touche ni à la table `projects` ni au réseau : tout ce dont il a besoin est dans `payload` (`RenderJobPayload`).
- Fichiers : `<STORAGE_ROOT>/projects/<projectId>/` + chemin relatif du payload. Le worker vérifie `PROJECT_RELATIVE_FILE_PATTERN` **et** que le chemin résolu reste dans ce dossier. Il écrit un fichier temporaire, puis le renomme en `output.file` après validation.
- Ces requêtes sont exécutées par `backend/test/database.test.ts` : prise unique, ordre, limite de rendus, détenteur du job, bail expiré.

## Règles de rendu (proposition D-07)

Détail dans le commentaire « RÈGLES DE RENDU » de `contract.ts` : audio de la source uniquement ; B-roll lu depuis son début ; `cover` = recadrage centré, `contain` = bandes noires ; segment limité à la durée du média choisi (dernière image figée seulement pour l'écart d'arrondi) ; aucun chevauchement ; temps alignés sur la frame ; MP4 H.264/AAC avec faststart.

## Proposer une modification

1. Décrire le problème concret, la modification et les composants touchés.
2. Attendre l'accord d'Alex dès que cela change un type, un nom ou une règle.
3. Ajouter un champ optionnel ou un code d'erreur est compatible ; renommer, supprimer ou changer un type impose `SCHEMA_VERSION + 1`.
4. Mettre à jour l'exemple JSON et noter la décision dans `docs/DECISIONS.md`.
