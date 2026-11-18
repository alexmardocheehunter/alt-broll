# ALT B-ROLL

Application web qui repère les passages d'une vidéo à illustrer, propose des plans de coupe (B-rolls) Pixabay, laisse l'utilisateur les ajuster, puis exporte un MP4 qui conserve l'audio original.

- Référence commune : [PROJECT_MASTER.txt](PROJECT_MASTER.txt), extrait à l'identique de `LES INSTRUCTIONS.txt`.
- Contrat de données partagé : [shared/contract.ts](shared/contract.ts), **proposition v1 à valider par Alex** ([shared/README.md](shared/README.md)).
- API : [docs/API.md](docs/API.md). Décisions et points ouverts : [docs/DECISIONS.md](docs/DECISIONS.md).

## Qui fait quoi

| Dossier | Responsable | Contenu |
|---|---|---|
| `shared/` | Alex (valide) | Contrat commun : types, constantes, protocole SQLite des jobs |
| `backend/` | Claude Code | API REST, SQLite, orchestration Groq / OpenRouter / Pixabay |
| `renderer/` | Codex | Worker de rendu, FFmpeg, validation du MP4 |
| `tests/` | OpenCode | Fixtures, tests de contrat, d'intégration et de sécurité, rapports QA |
| `frontend/` | Alex | Interface HTML/CSS/JS, Firebase Hosting |
| `docs/` | partagé | Chacun documente son périmètre ; Alex arbitre les documents communs |

Aucun agent ne modifie le dossier d'un autre sans accord explicite d'Alex.

## Démarrage rapide (backend)

Prérequis : Node.js 24+, FFmpeg et ffprobe dans le PATH.

```powershell
Copy-Item .env.example .env   # puis renseigner les clés (jamais dans Git)
cd backend
npm install
npm run dev                   # http://127.0.0.1:3000/api/health
```

Détails : [backend/README.md](backend/README.md).

## Configuration

Un seul fichier `.env` à la racine, lu par le backend et par le worker ; les chemins relatifs y sont résolus depuis la racine. Modèle commenté : [.env.example](.env.example).
