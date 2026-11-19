# API ALT B-ROLL

> Statut : **spécification v1 adoptée** (18/11/2026, Claude Code). Les types exacts sont dans [shared/contract.ts](../shared/contract.ts).
> **Codé (étapes 1 à 5) : tout le parcours P0 côté backend** — projets, import, lecture de la vidéo source, analyse (Groq, OpenRouter, Pixabay), modification des B-rolls, export et téléchargement. Vérifié de bout en bout le 19/11 avec le worker de Codex. Restent la suppression de projet (D-11) et la connexion Google (D-04), reportées.

Base : `APP_BASE_URL` (développement : `http://localhost:3000`). Corps en JSON UTF-8, sauf l'import (multipart) et le téléchargement (MP4).

## Conventions

- **Temps** : secondes décimales (précision ms) sur l'axe de la vidéo source. **Dates** : ISO 8601 UTC.
- **Identifiant de requête** : chaque réponse porte l'en-tête `X-Request-Id`, repris dans les erreurs. À joindre à tout rapport de bug.
- **Erreurs** : statut HTTP 4xx/5xx et corps `ApiErrorResponse` :

  ```json
  {
    "error": { "code": "VIDEO_TOO_LONG", "stage": "upload", "message": "La vidéo dure 4 min 12 s ; la limite de la bêta est 3 min.", "retryable": false },
    "requestId": "6f1c2a9e-…"
  }
  ```

  `code` est stable (liste `ERROR_CODES`) ; `message` s'affiche tel quel. Aucune stack trace, clé API ni chemin serveur n'est renvoyé.
- **Révision** : chaque projet a une `revision`. Les écritures envoient la révision connue ; si elle n'est plus actuelle → `409 REVISION_CONFLICT` : recharger le projet puis réessayer.
- **Polling** : pendant l'analyse ou l'export, interroger la route de statut toutes les 2 s ; arrêter sur `completed` ou `failed`.
- **CORS** : seules les origines listées dans `FRONTEND_ORIGIN` sont acceptées. Servir le frontend par un serveur local (ex. Live Server, port 5500), pas en `file://`.
- **Accès** : connexion Google décidée (D-04), mais reportée. Le moment venu : `Authorization: Bearer <jeton Firebase>` sur les routes `/api/projects…`, et liens de `project.urls` signés et temporaires (utilisables dans `<video src>`). D'ici là, les routes sont ouvertes, protégées par des identifiants impossibles à deviner et une limite de débit.

## Routes

| Méthode | Route | Rôle | Succès | État |
|---|---|---|---|---|
| GET | `/api/health` | État du serveur, de la base et de FFmpeg | 200 `HealthResponse` (503 si dégradé) | ✅ codé |
| GET | `/api/config` | Limites publiques pour l'interface | 200 `PublicConfigResponse` | ✅ codé |
| POST | `/api/projects` | Crée un projet | 201 `CreateProjectResponse` | ✅ codé |
| POST | `/api/projects/:id/upload` | Reçoit la vidéo (champ `video`) | 200 `UploadSourceResponse` | ✅ codé |
| POST | `/api/projects/:id/analyze` | Lance l'analyse | 202 `ProjectStatusResponse` | ✅ codé |
| GET | `/api/projects/:id` | Projet complet | 200 `GetProjectResponse` | ✅ codé |
| GET | `/api/projects/:id/status` | Statuts d'analyse et de rendu (polling) | 200 `ProjectStatusResponse` | ✅ codé |
| GET | `/api/projects/:id/suggestions` | B-rolls, candidats, timeline | 200 `SuggestionsResponse` | ✅ codé (vide avant l'analyse) |
| PATCH | `/api/projects/:id/timeline` | Modifie les B-rolls | 200 `UpdateTimelineResponse` | ✅ codé |
| POST | `/api/projects/:id/render` | Demande un export | 202 `StartRenderResponse` | ✅ codé |
| GET | `/api/projects/:id/render/status` | Progression de l'export | 200 `RenderStatusResponse` | ✅ codé |
| GET | `/api/projects/:id/download` | MP4 final | 200 `video/mp4` | ✅ codé |
| GET | `/api/projects/:id/media/source` | Vidéo source pour le lecteur (Range) | 200/206 `video/mp4` | ✅ codé (ajout) |
| DELETE | `/api/projects/:id` | Supprime le projet et ses fichiers | 204 | reporté avec la connexion Google (D-11) |

## Parcours type

1. `POST /api/projects` → `project.id`.
2. `POST /api/projects/:id/upload` (multipart, champ `video`) → `project.source`, validé par ffprobe.
3. `POST /api/projects/:id/analyze` → 202 ; polling de `GET …/status` jusqu'à `analysis.status = "completed"`.
4. `GET /api/projects/:id` → `brollItems` (suggestions et candidats), `timeline.segments` (preview), `urls.source` (lecteur).
5. `PATCH …/timeline` à chaque modification → projet à jour, `revision + 1`.
6. `POST …/render` avec `{ "revision": n }` → 202 `preparing` ; polling de `GET …/render/status` jusqu'à `completed`.
7. `GET …/download`, ou le lien `project.urls.download`.

Exemple complet de projet : [shared/examples/project.example.json](../shared/examples/project.example.json) (données fictives).

## Détail des routes

### GET /api/health ✅

200 si la base, ffmpeg et ffprobe sont disponibles ; sinon 503 avec `status: "degraded"`. `providers` indique seulement si chaque fournisseur est configuré, jamais les clés.

### GET /api/config ✅

```json
{
  "schemaVersion": 1,
  "upload": { "fieldName": "video", "maxBytes": 157286400, "minDurationSeconds": 5, "maxDurationSeconds": 180, "acceptedMimeTypes": ["video/mp4"], "acceptedExtensions": [".mp4"] },
  "timeline": { "minSegmentSeconds": 1, "maxSegmentSeconds": 10, "maxBrollItems": 8, "maxCandidatesPerItem": 4, "timePrecisionDecimals": 3 },
  "fits": ["cover", "contain"]
}
```

### POST /api/projects ✅

Corps vide. 201 `{ project }` : `source` null, `analysis.status` et `render.status` à `idle`, `revision` à 0.
Erreurs : 429 `RATE_LIMITED` (avec en-tête `Retry-After`) · 409 `CONFLICT` si la limite de projets actifs est atteinte (D-11, reportée avec la connexion Google).

### POST /api/projects/:id/upload ✅

`multipart/form-data`, un seul fichier dans le champ `video`. Dans l'ordre, le serveur :
1. refuse tout de suite si le projet n'existe pas, si une analyse ou un export est en cours, ou si la taille annoncée dépasse la limite ;
2. contrôle le nom (`.mp4`) et le type déclaré (`video/mp4`, ou `application/octet-stream` pour les clients génériques) avant d'écrire quoi que ce soit ;
3. reçoit le fichier dans un dossier temporaire, sous un nom qu'il génère ;
4. vérifie la signature MP4 du contenu, puis l'analyse avec ffprobe : piste vidéo, durée, dimensions d'affichage (rotation appliquée), cadence, codec vidéo (**H.264 seul en bêta**, D-08), présence d'audio ;
5. range le fichier dans `source/` du projet. Une nouvelle vidéo remplace la précédente, dont le fichier est supprimé, et remet à zéro transcription, analyse et B-rolls.

Le fichier temporaire est supprimé dans tous les cas, accepté ou refusé. Le nom d'origine n'est conservé que pour l'affichage (`source.originalName`, sans dossier ni caractère de contrôle).
200 `{ project }` avec `source` renseigné et `revision + 1`.
Erreurs : 400 `UPLOAD_MISSING_FILE`, `UPLOAD_INTERRUPTED`, `BAD_REQUEST` · 413 `UPLOAD_TOO_LARGE` · 415 `UPLOAD_UNSUPPORTED_TYPE` · 422 `VIDEO_UNREADABLE`, `VIDEO_NO_VIDEO_STREAM`, `VIDEO_NO_AUDIO`, `VIDEO_TOO_SHORT`, `VIDEO_TOO_LONG`, `VIDEO_UNSUPPORTED_CODEC` · 409 `CONFLICT` (analyse ou export en cours), `REVISION_CONFLICT` (projet modifié pendant l'envoi) · 404 `NOT_FOUND` · 429 `RATE_LIMITED` · 503 `INTERNAL_ERROR` (ffprobe indisponible sur le serveur).
Côté interface, suivre la progression de l'envoi avec `XMLHttpRequest` (`upload.onprogress`) : `fetch` ne la fournit pas.

### POST /api/projects/:id/analyze ✅

Corps vide. 202 `ProjectStatusResponse` avec `analysis.status = "queued"`. L'analyse tourne ensuite en tâche de fond, une à la fois ; suivre `GET …/status` toutes les 2 s. Durée mesurée : ~30 s pour une vidéo de 34 s.

| Étape (`analysis.stage`) | Ce qui se passe |
|---|---|
| `extracting_audio` | audio mono 16 kHz extrait par FFmpeg |
| `transcribing` | Groq Whisper, français imposé (`TRANSCRIPTION_LANGUAGE`), horodatage par segment et par mot ; segments « sans parole » écartés |
| `extracting_keyframes` | 12 images (une par tranche, coupe de scène préférée) en planche contact 4 × 3 horodatée |
| `analyzing_content` | modèle OpenRouter avec la planche contact ; schéma JSON imposé ; si l'appel avec image échoue, nouvel essai sur le texte seul |
| `searching_broll` | Pixabay, jusqu'à 4 candidats par suggestion (orientation de la source et durée suffisante d'abord) ; sans résultat, nouvel essai avec 2 mots-clés |

Résultat (`analysis.status = "completed"`) : `transcript`, `analysis.summary`, `analysis.model` (modèle qui a réellement répondu), `analysis.keyframes` et `brollItems`. Les suggestions sont environ une par 20 s de vidéo (1 à 8), durent de 1 à 10 s, ne se chevauchent pas, et chacune arrive avec : premier candidat sélectionné, `status: "suggested"`, `fit: "cover"`, `enabled: true`, fin raccourcie si la vidéo choisie est plus courte. `visualAnalysisAvailable` ne vaut `true` que si un modèle acceptant les images a réellement reçu la planche contact. Une nouvelle analyse remplace la précédente (transcription et B-rolls).

Erreurs immédiates : 409 `ANALYSIS_NOT_READY` (pas de vidéo) · 409 `ANALYSIS_ALREADY_RUNNING` · 409 `CONFLICT` (export en cours) · 503 `PROVIDER_NOT_CONFIGURED` (clés absentes) · 429 `RATE_LIMITED` (limite horaire par adresse IP, ou plafond `MAX_ANALYSES_PER_DAY` atteint) · 404 `NOT_FOUND`.
Échecs en cours d'analyse (`analysis.status = "failed"`, `analysis.error`) : `TRANSCRIPTION_EMPTY` (aucune parole), `VIDEO_UNREADABLE`, `PROVIDER_NOT_CONFIGURED` (clé ou crédit refusé), `PROVIDER_RATE_LIMITED`, `PROVIDER_TIMEOUT`, `PROVIDER_UNAVAILABLE`, `PROVIDER_INVALID_RESPONSE`, `ANALYSIS_INTERRUPTED` (redémarrage du serveur), `INTERNAL_ERROR`. `retryable` indique s'il suffit de relancer.

Tests hors ligne : avec `PROVIDER_MODE=mock` (refusé en production), les trois services sont simulés et tout est signalé comme tel (`provider: "simulation"`, modèle `simulation-hors-ligne`, textes « [Simulation] », URL en `.invalid`).

### GET /api/projects/:id · GET …/status · GET …/suggestions ✅

Lecture seule. `…/status` est la réponse légère prévue pour le polling. Un identifiant inconnu ou mal formé répond 404 `NOT_FOUND`. `render` reflète le dernier job écrit par le worker dans `render_jobs`.

### PATCH /api/projects/:id/timeline ✅

```json
{
  "baseRevision": 7,
  "items": [
    { "id": "broll_mg02", "selectedCandidateId": "cand_mg02a", "fit": "cover" },
    { "id": "broll_sk03", "status": "rejected" }
  ]
}
```

Champs modifiables : `startSeconds`, `endSeconds`, `selectedCandidateId`, `status`, `fit`, `enabled` (`EDITABLE_BROLL_FIELDS`). Appliqué en entier ou pas du tout ; temps arrondis à la ms ; `revision + 1`.
Règles : `0 ≤ startSeconds < endSeconds ≤ source.durationSeconds` ; durée de 1 à 10 s, et au plus la durée du candidat choisi (pour passer à un candidat plus court, envoyer la durée réduite dans le même PATCH) ; candidat appartenant à l'élément ; aucun chevauchement entre B-rolls montés (un B-roll refusé ou mis de côté peut en chevaucher un autre).
Actions de l'interface : accepter → `status: "accepted"` ; refuser → `status: "rejected"` ; mettre de côté → `enabled: false` ; remplacer la vidéo → `selectedCandidateId` ; déplacer ou ajuster → `startSeconds` / `endSeconds` ; cadrage → `fit`.
200 `{ project }` (avec `timeline` recalculée). Une liste `items` vide ne modifie rien et ne change pas la révision. Pas de limite horaire : prévu pour une sauvegarde automatique environ 1 s après chaque modification. Un export déjà lancé n'est pas affecté (il porte sur sa propre révision).
Erreurs : 400 `VALIDATION_FAILED` (champ inconnu, non modifiable ou mal formé ; `baseRevision` absent) · 409 `REVISION_CONFLICT` · 409 `CONFLICT` (analyse en cours) · 422 `TIMELINE_INVALID` · 422 `TIMELINE_OVERLAP` · 404 `NOT_FOUND`.

### POST /api/projects/:id/render ✅

Corps `{ "revision": 7 }` (la révision affichée : on exporte ce que l'utilisateur voit). Crée un job durable en `preparing` avec l'instantané du montage (`timeline.segments`), puis, en tâche de fond :
1. le backend récupère chaque B-roll retenu dans `broll/<candidat>.mp4` : déjà présent → réutilisé ; sinon téléchargé (HTTPS et domaines pixabay.com uniquement, y compris après redirection, 200 Mo et 2 min au plus, 3 en parallèle), ou fabriqué localement en mode simulation ;
2. chaque fichier est vérifié avec ffprobe et sa durée réelle mesurée ; un segment plus long que la vidéo réelle est ramené à sa durée (exigence du worker, D-07) ;
3. le job passe en `queued` ; le worker le prend (`rendering`), puis le termine en `completed` après validation ffprobe, ou en `failed`.

202 `{ render }` avec `render.status = "preparing"`. Mesuré le 19/11 sur une vidéo de 34 s : préparation ~45 s (2 B-rolls 1080p), rendu ~15 s.
Erreurs : 400 `VALIDATION_FAILED` · 409 `RENDER_NOT_READY` (analyse non terminée) · 409 `REVISION_CONFLICT` · 422 `RENDER_NO_SEGMENTS` (aucun B-roll monté) · 409 `RENDER_ALREADY_ACTIVE` · 429 `RATE_LIMITED` · 404 `NOT_FOUND`.
Échecs en cours d'export, dans `render.error` : `RENDER_MEDIA_DOWNLOAD_FAILED` (B-roll introuvable, refusé ou illisible : relancer ou choisir une autre proposition), `RENDER_INTERRUPTED` (redémarrage du serveur pendant la préparation), et côté worker `RENDER_INPUT_MISSING`, `RENDER_FFMPEG_FAILED`, `RENDER_OUTPUT_INVALID`, `RENDER_TIMEOUT`, `RENDER_WORKER_LOST`, `RENDER_INVALID_JOB`.

### GET /api/projects/:id/render/status ✅

200 `RenderStatusResponse` : `render.status` passe par `preparing` → `queued` → `rendering` (avec `progress` de 0 à 1) → `completed` ou `failed`. Si `render.revision` est inférieure à `projectRevision`, l'export ne reflète plus le montage actuel.

### GET /api/projects/:id/download ✅

200 `video/mp4` avec `Content-Disposition: attachment; filename="<nom de la vidéo importée>-alt-broll.mp4"`, requêtes `Range` acceptées, uniquement si le dernier export est `completed` et que le fichier validé existe. Lien prêt à l'emploi : `project.urls.download`.
Erreurs : 409 `DOWNLOAD_NOT_READY` · 404 `NOT_FOUND`.

### GET /api/projects/:id/media/source ✅ (ajout)

Sert la vidéo importée au lecteur HTML5 (`<video src="…">` avec l'URL `project.urls.source`) ; les requêtes `Range` sont acceptées (206), ce qui permet de se déplacer dans la vidéo. 404 `NOT_FOUND` si aucune vidéo n'a été importée. L'URL reste la même quand la vidéo est remplacée ; la réponse est en `Cache-Control: no-cache` avec ETag, donc le navigateur revalide et reçoit la nouvelle vidéo. Après un nouvel import (`source.storedFileName` a changé), appeler `video.load()` pour que le lecteur la recharge. En attendant D-04, ce lien n'est protégé que par l'identifiant du projet, impossible à deviner.

## Statuts HTTP

| HTTP | Usage |
|---|---|
| 400 | Requête mal formée (`BAD_REQUEST`, `UPLOAD_MISSING_FILE`, `UPLOAD_INTERRUPTED`) |
| 401 / 403 | Accès refusé (selon D-04) |
| 404 | Projet ou route inexistants (`NOT_FOUND`) |
| 409 | État incompatible (`REVISION_CONFLICT`, `*_ALREADY_*`, `*_NOT_READY`, `CONFLICT`) |
| 413 / 415 | Fichier trop volumineux / type refusé |
| 422 | Forme valide mais contenu refusé (`VIDEO_*`, `TIMELINE_*`, `RENDER_NO_SEGMENTS`) |
| 429 | Trop de requêtes (`RATE_LIMITED`) |
| 500 | `INTERNAL_ERROR` : détail dans les logs, retrouvable par `requestId` |
| 502 / 503 / 504 | Fournisseur externe (`PROVIDER_*`) |
