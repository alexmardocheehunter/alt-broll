# tests/ : contrôle qualité d'ALT B-ROLL (OpenCode)

Ce dossier contient les **fixtures**, les **tests de contrat, d'intégration, de rendu et de sécurité** et les **rapports QA** d'ALT B-ROLL. Il est la propriété d'OpenCode (PROJECT_MASTER §9). Le backend (`backend/`) et le worker (`renderer/`) ne sont jamais modifiés depuis ici : les tests les observent.

## Règles non négociables

| Règle | Application |
|---|---|
| Aucun appel à Groq, OpenRouter ou Pixabay | Clés fournisseur forcées à `''` au lancement du backend ; aucune requête sortante hors `127.0.0.1` |
| Aucun secret dans les tests | Le fichier `.env` n'est **jamais** lu ; `.env.example` doit rester vide |
| Aucune donnée tierce | Tous les médias sont synthétiques (FFmpeg `lavfi`), voir [`fixtures/README.md`](fixtures/README.md) |
| Aucune dépendance npm | Uniquement la bibliothèque standard de Node 24 (`node:test`, `node:sqlite`, `fetch`) |
| Aucune modification de `backend/` ou `renderer/` | Les tests importent les modules backend en lecture seule, ou parlent au vrai serveur en HTTP |
| Aucun faux succès | Un test qui ne peut pas s'exécuter est marqué `skip` avec la raison exacte ; jamais un `return` silencieux |

## Prérequis

- **Node.js 24 ou plus récent** (`node --version`). Node exécute directement les `.ts` (syntaxe effaçable).
- **FFmpeg et ffprobe** dans le `PATH`, ou `FFMPEG_PATH` / `FFPROBE_PATH`.
- PowerShell ou bash ; les commandes ci-dessous fonctionnent sous Windows.
- Aucun `npm install` n'est nécessaire dans `tests/`.

Si FFmpeg est absent, les tests qui en dépendent sont marqués `skip` avec la raison ; le reste s'exécute.

## Commandes

Depuis `tests/` :

```powershell
npm test                  # toute la suite (contrat + renderer + intégration + sécurité)
npm run test:contract     # validation du contrat et des fixtures JSON
npm run test:renderer     # protocole SQLite backend → worker, intégrité des fixtures
npm run test:integration  # vrai backend lancé sur un port libre, base et stockage temporaires
npm run test:security     # audit statique + audit HTTP/CORS/erreurs/limites
npm run fixtures          # génère les fixtures média manquantes
npm run fixtures:force    # régénère tout et réécrit le manifeste SHA-256
```

Les tests d'intégration démarrent le **vrai** `backend/src/server.ts` : compter environ 10 s pour la suite complète.

## Arborescence

```
tests/
├── contract/     Contrat shared/contract.ts, fixtures JSON, cas négatifs
├── renderer/     Protocole SQLite du worker (claimNext, heartbeat…) + fixtures média
├── integration/  Backend réel en HTTP + services backend importés directement
├── security/     Audit statique du dépôt + audit HTTP dynamique
├── lib/          Helpers : chemins, ffprobe, lanceur backend, validateurs exécutables
│   └── validation/  Validateurs Project, RenderJobPayload, ErrorInfo, réponses API
├── fixtures/     Médias synthétiques, projets et jobs JSON, manifeste SHA-256
└── reports/      Rapports QA datés (cartographie, findings)
```

## Ce que couvre chaque suite

### `contract/` : le contrat avant tout

- `schema.test.ts` : le projet d'exemple et les fixtures respectent `shared/contract.ts`.
- `negative.test.ts` : ~30 mutations doivent être refusées (schéma, temps, révisions, erreurs, timeline).
- `api.test.ts` : validateurs des réponses HTTP (création, lecture, statut, suggestions, rendu, erreurs).
- `rules.test.ts` : constantes, motifs d'identifiants, DDL `render_jobs`, requêtes SQL de référence.

Les validateurs de `lib/validation/` comblent un manque : `shared/contract.ts` ne contient **que des types**, donc aucune validation exécutable. Toute évolution du contrat doit être répercutée ici (et signalée à Alex).

### `renderer/` : ce que le worker doit garantir

`protocol.test.ts` exécute les requêtes `RENDER_JOB_SQL` sur une base SQLite en mémoire :

- `claimNext` : FIFO, un seul job à la fois, limite de rendus simultanés, remise à zéro de la progression ;
- `heartbeat` : seul le worker propriétaire écrit, progression bornée `[0, 1]` par un `CHECK` ;
- `complete` / `fail` : uniquement depuis `rendering`, effacement du bail, message sans chemin ;
- `recoverStale` : remise en file tant qu'il reste une tentative, puis `RENDER_WORKER_LOST`.

`fixtures.test.ts` vérifie les médias réels (durées, dimensions, rotation, audio, images non figées) et la cohérence des JSON de projet/job avec ces médias.

### `integration/` : le backend tel qu'il tourne

- `backend.test.ts` : socle (health, config, schéma SQLite, logs), routes projets livrées, et baseline 404 des routes encore attendues.
- `journey.test.ts` : parcours P0 (création, import, refus d'import, streaming Range, analyse sans clé). Le parcours complet est `skip` tant qu'aucun mode fournisseur hors ligne n'existe.
- `backend-units.test.ts` : services backend importés directement (projets, révisions, timeline D-06, `RenderState`, ffprobe, stockage). Ces tests donnent à Claude un retour avant même le branchement HTTP.

Le lanceur `lib/backend-server.ts` :

- trouve un port libre et démarre `node src/server.ts` ;
- utilise une base SQLite et un stockage **temporaires** ;
- force `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `PIXABAY_API_KEY` à `''` ;
- accepte des variables supplémentaires via `startBackend({ env: { ... } })` (ex. `MAX_UPLOAD_MB=1`) ;
- supprime le dossier temporaire à l'arrêt.

### `security/` : ce qui ne doit jamais arriver

- `static.test.ts` : secrets, `.gitignore`, absence de dépendances et d'URLs externes, CORS non ouvert, chemins absolus, `shell: true` interdit dans le worker.
- `api.test.ts` : en-têtes, CORS/préflight, erreurs structurées, traversée de chemin, nom de fichier malveillant, type MIME incohérent, limite de débit (429), refus de démarrer en production sans clés.

## Conventions d'écriture

- Un test = un comportement ; le nom décrit l'attendu, en français.
- Les fixtures portent des identifiants préfixés `fixture_`, `proj_fix_`, `cand_fix_`, `job_fix_` pour être reconnaissables.
- Les URLs de fixture utilisent `example.com` ou `localhost` uniquement.
- Les messages d'erreur attendus sont vérifiés **et** le corps complet est validé (`validateApiErrorResponse`).
- Un test qui dépend d'une route non livrée utilise `t.skip('raison précise')` : la raison doit citer la route et le responsable.
- Un défaut backend connu et non corrigeable par OpenCode est écrit comme test `t.todo(...)` référencé dans `docs/OPENCODE_QA_STATUS.md`, jamais masqué par une assertion contraire au contrat.

## Cycle de vie d'une route backend

1. La route est absente : `backend.test.ts` vérifie une **404 structurée** sur un vrai projet.
2. Claude livre la route : ce test échoue volontairement avec « semble implémentée ».
3. OpenCode remplace la baseline par les assertions de contrat, puis complète `journey.test.ts`.
4. Quand un mode fournisseur hors ligne sera fourni, le parcours complet sera activé.

## Dépannage

| Symptôme | Cause probable | Action |
|---|---|---|
| `FFmpeg/ffprobe introuvables` | binaire absent du PATH | installer FFmpeg ou définir `FFMPEG_PATH` / `FFPROBE_PATH` |
| `Le backend s'est arrêté avant d'être prêt` | erreur de configuration ou de syntaxe backend | lire la sortie du processus dans le message d'erreur |
| `EADDRINUSE` | port occupé | relancer : le lanceur choisit un port libre à chaque fois |
| Test média en échec après régénération | manifeste obsolète | `npm run fixtures:force` puis relancer |
| Test de sécurité « chemin Windows » | chemin absolu ajouté dans un fichier | remplacer par un chemin relatif au projet |

## Rapports

Les constats sont publiés dans [`reports/`](reports/) et l'état de coordination dans [`../docs/OPENCODE_QA_STATUS.md`](../docs/OPENCODE_QA_STATUS.md). Un rapport doit distinguer :

- **bug réel** (comportement contraire au contrat, reproductible) ;
- **limite** (choix ou dépendance externe non couverte par les tests) ;
- **amélioration facultative** (confort, performance, style).
