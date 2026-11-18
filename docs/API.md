# API ALT B-ROLL

> Statut : **spécification v1 proposée** (18/11/2026, Claude Code). Les types exacts sont dans [shared/contract.ts](../shared/contract.ts), à valider par Alex.
> **Codé (étapes 1 et 2) : santé, configuration, création et lecture de projet, import de la vidéo et lecture de la vidéo source.** Les routes marquées « à coder » sont spécifiées ici mais pas encore implémentées : elles répondent 404.

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
- **Accès** : en attente de la décision D-04. Proposition : `Authorization: Bearer <code testeur>` sur toutes les routes `/api/projects…` ; les liens de `project.urls` sont signés et temporaires, donc utilisables dans `<video src>` et un lien de téléchargement.

## Routes

| Méthode | Route | Rôle | Succès | État |
|---|---|---|---|---|
| GET | `/api/health` | État du serveur, de la base et de FFmpeg | 200 `HealthResponse` (503 si dégradé) | ✅ codé |
| GET | `/api/config` | Limites publiques pour l'interface | 200 `PublicConfigResponse` | ✅ codé |
| POST | `/api/projects` | Crée un projet | 201 `CreateProjectResponse` | ✅ codé |
| POST | `/api/projects/:id/upload` | Reçoit la vidéo (champ `video`) | 200 `UploadSourceResponse` | ✅ codé |
| POST | `/api/projects/:id/analyze` | Lance l'analyse | 202 `ProjectStatusResponse` | à coder |
| GET | `/api/projects/:id` | Projet complet | 200 `GetProjectResponse` | ✅ codé |
| GET | `/api/projects/:id/status` | Statuts d'analyse et de rendu (polling) | 200 `ProjectStatusResponse` | ✅ codé |
| GET | `/api/projects/:id/suggestions` | B-rolls, candidats, timeline | 200 `SuggestionsResponse` | ✅ codé (vide avant l'analyse) |
| PATCH | `/api/projects/:id/timeline` | Modifie les B-rolls | 200 `UpdateTimelineResponse` | à coder |
| POST | `/api/projects/:id/render` | Demande un export | 202 `StartRenderResponse` | à coder |
| GET | `/api/projects/:id/render/status` | Progression de l'export | 200 `RenderStatusResponse` | à coder |
| GET | `/api/projects/:id/download` | MP4 final | 200 `video/mp4` | à coder |
| GET | `/api/projects/:id/media/source` | Vidéo source pour le lecteur (Range) | 200/206 `video/mp4` | ✅ codé (ajout) |
| DELETE | `/api/projects/:id` | Supprime le projet et ses fichiers | 204 | proposé (D-11) |

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
Erreurs : 429 `RATE_LIMITED` (avec en-tête `Retry-After`) · 409 `CONFLICT` si la limite de projets actifs est atteinte (D-11, pas encore appliquée).

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

### POST /api/projects/:id/analyze

Corps vide. 202 `ProjectStatusResponse` (`analysis.status` à `queued` ou `processing`).
Étapes : `extracting_audio` → `transcribing` → `extracting_keyframes` → `analyzing_content` → `searching_broll`. À la fin, `brollItems` est remplacé et `revision` augmente.
Échec : `analysis.status = "failed"` et `analysis.error` renseigné (`PROVIDER_*`, `TRANSCRIPTION_EMPTY`, `ANALYSIS_INTERRUPTED`…). Si la vision est indisponible, l'analyse continue sur le texte seul et `visualAnalysisAvailable` vaut `false`.
Erreurs immédiates : 409 `ANALYSIS_NOT_READY` (pas de vidéo) · 409 `ANALYSIS_ALREADY_RUNNING` · 503 `PROVIDER_NOT_CONFIGURED`.

### GET /api/projects/:id · GET …/status · GET …/suggestions ✅

Lecture seule. `…/status` est la réponse légère prévue pour le polling. Un identifiant inconnu ou mal formé répond 404 `NOT_FOUND`. `render` reflète le dernier job écrit par le worker dans `render_jobs`.

### PATCH /api/projects/:id/timeline

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
Règles : `0 ≤ startSeconds < endSeconds ≤ source.durationSeconds` ; durée de 1 à 10 s, et au plus la durée du candidat choisi (pour passer à un candidat plus court, envoyer la durée réduite dans le même PATCH) ; candidat appartenant à l'élément ; aucun chevauchement entre B-rolls montés.
200 `{ project }`. Erreurs : 409 `REVISION_CONFLICT` · 422 `TIMELINE_INVALID` · 422 `TIMELINE_OVERLAP` · 409 `CONFLICT` (analyse en cours).

### POST /api/projects/:id/render

Corps `{ "revision": 7 }`. Crée un job durable en `preparing` : le backend télécharge et vérifie les B-rolls retenus, puis passe le job en `queued`. Le worker le prend (`rendering`), puis le termine en `completed` après validation ffprobe, ou en `failed`.
202 `{ render }`. Erreurs : 409 `RENDER_NOT_READY` (analyse non terminée) · 409 `REVISION_CONFLICT` · 422 `RENDER_NO_SEGMENTS` · 409 `RENDER_ALREADY_ACTIVE`.
Échecs asynchrones, dans `render.error` : `RENDER_MEDIA_DOWNLOAD_FAILED`, `RENDER_FFMPEG_FAILED`, `RENDER_OUTPUT_INVALID`, `RENDER_TIMEOUT`, `RENDER_WORKER_LOST`…

### GET /api/projects/:id/render/status

200 `RenderStatusResponse`. Si `render.revision` est inférieure à `projectRevision`, l'export ne reflète plus le montage actuel.

### GET /api/projects/:id/download

200 `video/mp4` avec `Content-Disposition: attachment; filename="alt-broll-<id court>.mp4"`, uniquement si le dernier rendu est `completed` et que le fichier validé existe.
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
