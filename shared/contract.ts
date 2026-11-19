/**
 * =====================================================================
 * ALT B-ROLL : CONTRAT COMMUN (shared/contract.ts)
 * =====================================================================
 * Statut   : v1 ADOPTÉE le 18/11/2026 (rédigée par Claude Code ; choix délégués
 *            par Alex, propriétaire du fichier). Décisions : docs/DECISIONS.md.
 * Lecteurs : backend/ (Claude Code), renderer/ (Codex), tests/ (OpenCode),
 *            frontend/ (Alex : le frontend étant en JavaScript, il lit ce
 *            fichier comme une spécification).
 *
 * Règles du fichier
 * - Aucun import, aucune dépendance : importable tel quel par chaque composant.
 * - Syntaxe TypeScript « effaçable » uniquement (pas d'enum, de namespace ni de
 *   propriétés de paramètres) : Node.js 24 l'exécute sans compilation.
 * - Toute modification est proposée puis validée par Alex avant intégration
 *   (PROJECT_MASTER §6). Ajouter un champ optionnel ou un code d'erreur est
 *   compatible ; renommer, supprimer ou changer un type impose SCHEMA_VERSION + 1.
 *
 * Conventions
 * - Temps et durées en secondes (nombre décimal, arrondi à la milliseconde),
 *   toujours sur l'axe de la VIDÉO SOURCE. Intervalles semi-ouverts
 *   [startSeconds, endSeconds[.
 * - Dates de l'API : chaînes ISO 8601 UTC (Date#toISOString()).
 * - Dates en base SQLite : millisecondes depuis l'epoch (INTEGER, suffixe _ms).
 * - Identifiants : chaînes opaques générées par le serveur, conformes à ID_PATTERN.
 * - Textes destinés à l'utilisateur : français. Requêtes de recherche B-roll : anglais.
 */

// =====================================================================
// 1. Versions, identifiants, règles partagées
// =====================================================================

/** Version du format de ce contrat (Project, RenderJobPayload). */
export const SCHEMA_VERSION = 1;
export type SchemaVersion = typeof SCHEMA_VERSION;

/** Format de tout identifiant (projet, job, B-roll, candidat) : sûr dans un nom de fichier. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Chaîne ISO 8601 UTC, ex. "2026-11-18T14:20:00.000Z". */
export type IsoDateString = string;

/** Import de la vidéo source (POST /api/projects/:id/upload, multipart/form-data). */
export const UPLOAD_RULES = {
  /** Nom du champ fichier du formulaire multipart. */
  fieldName: 'video',
  acceptedMimeTypes: ['video/mp4'],
  acceptedExtensions: ['.mp4'],
} as const;

/**
 * Règles de montage : validées par le backend, affichées par le frontend,
 * revérifiées par le worker. Les limites de taille et de durée d'import sont,
 * elles, configurables côté serveur et exposées par GET /api/config.
 */
export const TIMELINE_RULES = {
  /** Durée minimale d'un B-roll (s). */
  minSegmentSeconds: 1,
  /** Durée maximale d'un B-roll (s). */
  maxSegmentSeconds: 10,
  /** Nombre maximal de suggestions B-roll par projet. */
  maxBrollItems: 8,
  /** Nombre maximal de candidats par suggestion. */
  maxCandidatesPerItem: 4,
  /** Décimales conservées sur les temps (3 = milliseconde). */
  timePrecisionDecimals: 3,
} as const;

// =====================================================================
// 2. Statuts (analyse et rendu sont indépendants)
// =====================================================================

/** Statut de l'analyse. */
export const ANALYSIS_STATUSES = ['idle', 'queued', 'processing', 'completed', 'failed'] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/** Étapes de l'analyse, dans l'ordre d'exécution (progression affichable = index / longueur). */
export const ANALYSIS_STAGES = [
  'extracting_audio',
  'transcribing',
  'extracting_keyframes',
  'analyzing_content',
  'searching_broll',
] as const;
export type AnalysisStage = (typeof ANALYSIS_STAGES)[number];

/** Statut d'un job de rendu en base (table render_jobs). */
export const RENDER_JOB_STATUSES = ['preparing', 'queued', 'rendering', 'completed', 'failed'] as const;
export type RenderJobStatus = (typeof RENDER_JOB_STATUSES)[number];

/** Statut du rendu exposé par l'API : 'idle' = aucun export demandé. */
export const RENDER_STATUSES = ['idle', ...RENDER_JOB_STATUSES] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];

/** Décision de l'utilisateur sur une suggestion B-roll. */
export const BROLL_ITEM_STATUSES = ['suggested', 'accepted', 'rejected'] as const;
export type BrollItemStatus = (typeof BROLL_ITEM_STATUSES)[number];

/** Cadrage du B-roll dans l'image de sortie (voir les règles de rendu, section 6). */
export const BROLL_FITS = ['cover', 'contain'] as const;
export type BrollFit = (typeof BROLL_FITS)[number];

/**
 * Banques média. 'simulation' : fournisseur simulé du mode de test hors ligne
 * (PROVIDER_MODE=mock), refusé en production. Pexels pourra être ajouté plus tard.
 */
export const BROLL_PROVIDERS = ['pixabay', 'simulation'] as const;
export type BrollProvider = (typeof BROLL_PROVIDERS)[number];

/** Services de transcription. 'simulation' : mode de test hors ligne (PROVIDER_MODE=mock), refusé en production. */
export const TRANSCRIPTION_PROVIDERS = ['groq', 'simulation'] as const;
export type TranscriptionProviderName = (typeof TRANSCRIPTION_PROVIDERS)[number];

// =====================================================================
// 3. Erreurs structurées
// =====================================================================

/** Étape où l'erreur s'est produite. */
export const ERROR_STAGES = [
  'request',
  'upload',
  'transcription',
  'keyframes',
  'analysis',
  'broll_search',
  'timeline',
  'render',
  'download',
  'internal',
] as const;
export type ErrorStage = (typeof ERROR_STAGES)[number];

/** Codes stables exploitables par le frontend. Ajouter un code est un changement compatible. */
export const ERROR_CODES = [
  // Requête et accès
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'REVISION_CONFLICT',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  // Import et validation de la vidéo source
  'UPLOAD_MISSING_FILE',
  'UPLOAD_TOO_LARGE',
  'UPLOAD_UNSUPPORTED_TYPE',
  'UPLOAD_INTERRUPTED',
  'VIDEO_UNREADABLE',
  'VIDEO_NO_VIDEO_STREAM',
  'VIDEO_NO_AUDIO',
  'VIDEO_TOO_SHORT',
  'VIDEO_TOO_LONG',
  'VIDEO_UNSUPPORTED_CODEC',
  // Services externes (Groq, OpenRouter, Pixabay)
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_INVALID_RESPONSE',
  // Analyse
  'ANALYSIS_NOT_READY',
  'ANALYSIS_ALREADY_RUNNING',
  'ANALYSIS_INTERRUPTED',
  'TRANSCRIPTION_EMPTY',
  // Montage (PATCH timeline)
  'TIMELINE_INVALID',
  'TIMELINE_OVERLAP',
  // Rendu : erreurs posées par le backend
  'RENDER_NOT_READY',
  'RENDER_NO_SEGMENTS',
  'RENDER_ALREADY_ACTIVE',
  'RENDER_MEDIA_DOWNLOAD_FAILED',
  'RENDER_INTERRUPTED',
  // Rendu : erreurs posées par le worker
  'RENDER_INVALID_JOB',
  'RENDER_INPUT_MISSING',
  'RENDER_FFMPEG_FAILED',
  'RENDER_OUTPUT_INVALID',
  'RENDER_TIMEOUT',
  'RENDER_WORKER_LOST',
  // Téléchargement
  'DOWNLOAD_NOT_READY',
  // Interne
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Erreur structurée transmise au navigateur. */
export interface ErrorInfo {
  code: ErrorCode;
  stage: ErrorStage;
  /** Message lisible (français), affichable tel quel. Jamais de clé API, de chemin serveur ni de stack trace. */
  message: string;
  /** true si refaire la même action plus tard peut réussir (panne ou quota temporaire). */
  retryable: boolean;
}

/** Corps de toute réponse d'erreur HTTP (4xx/5xx). */
export interface ApiErrorResponse {
  error: ErrorInfo;
  /** Identique à l'en-tête X-Request-Id : permet de retrouver l'erreur dans les logs serveur. */
  requestId: string;
}

// =====================================================================
// 4. Projet : source de vérité du montage
// =====================================================================

/** Vidéo importée, validée par ffprobe côté serveur. */
export interface SourceVideo {
  /** Nom d'origine, pour affichage uniquement : jamais utilisé pour construire un chemin. */
  originalName: string;
  /** Nom de stockage généré par le serveur (ex. "7c9e….mp4"), rangé dans source/. */
  storedFileName: string;
  /** Type MIME vérifié sur le contenu (pas seulement annoncé), ex. "video/mp4". */
  mimeType: string;
  sizeBytes: number;
  durationSeconds: number;
  /** Dimensions d'affichage, rotation des métadonnées appliquée. */
  width: number;
  height: number;
  /** Images par seconde moyennes, ex. 29.97. */
  frameRate: number;
  /** Codec vidéo selon ffprobe, ex. "h264". */
  videoCodec: string;
  audioPresent: boolean;
  /** Codec audio selon ffprobe, ex. "aac" ; null sans piste audio. */
  audioCodec: string | null;
}

export interface TranscriptSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface TranscriptWord {
  startSeconds: number;
  endSeconds: number;
  word: string;
}

/**
 * Transcription réelle issue de Groq Whisper, jamais inventée. Seul le mode de test
 * hors ligne produit provider = 'simulation', toujours signalé comme tel.
 */
export interface Transcript {
  provider: TranscriptionProviderName;
  /** Modèle réellement utilisé, ex. "whisper-large-v3-turbo". */
  model: string;
  /** Langue (ISO 639-1), ex. "fr". */
  language: string;
  text: string;
  segments: TranscriptSegment[];
  /** Horodatage mot à mot ; tableau vide si le fournisseur ne le renvoie pas. */
  words: TranscriptWord[];
}

/** Image représentative envoyée à l'analyse visuelle. */
export interface Keyframe {
  /** Position dans la planche contact 4 × 3 : 0 = en haut à gauche, lecture ligne par ligne. */
  index: number;
  timeSeconds: number;
}

/** État et résultat de l'analyse. */
export interface Analysis {
  status: AnalysisStatus;
  /** Étape en cours quand status = 'processing', sinon null. */
  stage: AnalysisStage | null;
  /** Modèle OpenRouter réellement utilisé ; null tant qu'il n'a pas été appelé. */
  model: string | null;
  /** true UNIQUEMENT si la planche contact a réellement été traitée par un modèle vision. */
  visualAnalysisAvailable: boolean;
  /** Au plus 12 images, avec leur instant dans la vidéo source. */
  keyframes: Keyframe[];
  /** Résumé court du contenu (français) ; null tant que l'analyse n'est pas terminée. */
  summary: string | null;
  startedAt: IsoDateString | null;
  completedAt: IsoDateString | null;
  /** Renseigné quand status = 'failed'. */
  error: ErrorInfo | null;
}

/** Vidéo proposée par la banque média pour une suggestion. */
export interface BrollCandidate {
  id: string;
  provider: BrollProvider;
  /** Identifiant du média chez le fournisseur. */
  providerMediaId: string;
  /** Titre affichable (Pixabay n'a pas de titre : ses mots-clés). */
  title: string;
  /** URL lisible directement par un <video> pour la prévisualisation (version légère). */
  previewUrl: string;
  /** URL de la version utilisée pour l'export (≤ 1080p), téléchargée par le backend. */
  downloadUrl: string;
  /** Page du média chez le fournisseur : provenance et lien d'attribution. */
  sourcePageUrl: string;
  thumbnailUrl: string | null;
  durationSeconds: number;
  /** Dimensions de la version downloadUrl. */
  width: number;
  height: number;
  /** Mention à afficher, ex. "Vidéo de Jean K. sur Pixabay". */
  attribution: string;
}

/**
 * Passage de la vidéo à illustrer, avec ses candidats et les choix de l'utilisateur.
 * La liste des BrollItem est à la fois la liste des suggestions et l'état éditable du montage.
 */
export interface BrollItem {
  id: string;
  /** Apparition du B-roll sur l'axe de la vidéo source (inclus). */
  startSeconds: number;
  /** Disparition du B-roll (exclu) ; startSeconds < endSeconds ≤ source.durationSeconds. */
  endSeconds: number;
  /** Pourquoi un plan de coupe ici : une phrase, en français. */
  reason: string;
  /** Mots-clés de recherche, en anglais. */
  searchQuery: string;
  /** De 0 à TIMELINE_RULES.maxCandidatesPerItem candidats, du plus au moins pertinent. */
  candidates: BrollCandidate[];
  /** Candidat actif, présent dans candidates ; null seulement si candidates est vide. */
  selectedCandidateId: string | null;
  /** Décision de l'utilisateur (voir la règle d'inclusion ci-dessous). */
  status: BrollItemStatus;
  fit: BrollFit;
  /** false = écarté temporairement de la preview et de l'export, sans perdre la décision ni les réglages. */
  enabled: boolean;
}

/*
 * RÈGLE D'INCLUSION (décision D-06)
 * Un BrollItem est monté, dans la preview comme dans l'export, si et seulement si :
 *   enabled === true && status !== 'rejected' && selectedCandidateId !== null
 * Le backend en déduit Project.timeline ; le frontend s'appuie sur
 * timeline.segments pour la preview ; le worker reçoit exactement ces segments.
 */

/** B-roll effectivement monté. */
export interface TimelineSegment {
  brollItemId: string;
  candidateId: string;
  startSeconds: number;
  endSeconds: number;
  fit: BrollFit;
}

/** Montage calculé par le backend à partir de brollItems (lecture seule, jamais envoyé par le client). */
export interface Timeline {
  /** Triés par startSeconds, sans chevauchement, inclus dans [0, source.durationSeconds]. */
  segments: TimelineSegment[];
}

/** État du dernier export, calculé à partir de la table render_jobs (lecture seule). */
export interface RenderState {
  status: RenderStatus;
  jobId: string | null;
  /** Révision exportée ; si elle est inférieure à Project.revision, l'export n'est plus à jour. */
  revision: number | null;
  /** Progression de 0 à 1, publiée par le worker. */
  progress: number;
  /** Fichier final validé par ffprobe ; null tant que status ≠ 'completed'. Aucun chemin serveur exposé. */
  outputFile: { sizeBytes: number; durationSeconds: number } | null;
  startedAt: IsoDateString | null;
  completedAt: IsoDateString | null;
  /** Renseigné quand status = 'failed'. */
  error: ErrorInfo | null;
}

/** Liens utilisables tels quels par le navigateur (<video src>, lien de téléchargement), recalculés à chaque réponse. */
export interface ProjectUrls {
  /** Vidéo source pour le lecteur ; null avant l'import. */
  source: string | null;
  /** MP4 final ; null tant que render.status ≠ 'completed'. */
  download: string | null;
}

/** Projet tel que renvoyé par l'API. */
export interface Project {
  id: string;
  schemaVersion: SchemaVersion;
  /** Augmente de 1 à chaque écriture du projet (import, analyse, montage). */
  revision: number;
  createdAt: IsoDateString;
  updatedAt: IsoDateString;
  /** null tant qu'aucune vidéo n'a été importée. */
  source: SourceVideo | null;
  /** null tant que la transcription n'a pas réussi. */
  transcript: Transcript | null;
  analysis: Analysis;
  /** Suggestions B-roll et choix de l'utilisateur (au plus TIMELINE_RULES.maxBrollItems). */
  brollItems: BrollItem[];
  /** Calculé par le backend (lecture seule). */
  timeline: Timeline;
  /** Calculé par le backend (lecture seule). */
  render: RenderState;
  /** Calculé par le backend (lecture seule). */
  urls: ProjectUrls;
}

// =====================================================================
// 5. API HTTP : corps des requêtes et des réponses (détails : docs/API.md)
// =====================================================================

/** GET /api/health */
export interface HealthResponse {
  /** 'degraded' (HTTP 503) si la base, FFmpeg ou ffprobe est indisponible. */
  status: 'ok' | 'degraded';
  service: 'alt-broll-backend';
  schemaVersion: SchemaVersion;
  time: IsoDateString;
  uptimeSeconds: number;
  checks: {
    database: 'ok' | 'error';
    ffmpeg: 'ok' | 'missing';
    ffprobe: 'ok' | 'missing';
  };
  /** Fournisseurs configurés côté serveur (jamais les clés elles-mêmes). */
  providers: { groq: boolean; openrouter: boolean; pixabay: boolean };
}

/** GET /api/config : règles publiques affichées par l'interface. */
export interface PublicConfigResponse {
  schemaVersion: SchemaVersion;
  upload: {
    fieldName: typeof UPLOAD_RULES.fieldName;
    maxBytes: number;
    minDurationSeconds: number;
    maxDurationSeconds: number;
    acceptedMimeTypes: readonly string[];
    acceptedExtensions: readonly string[];
  };
  timeline: typeof TIMELINE_RULES;
  fits: readonly BrollFit[];
}

/** Connexion (D-04) : « none » pendant la bêta ouverte, « firebase » = compte Google via Firebase Authentication. */
export const AUTH_MODES = ['none', 'firebase'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export interface AuthUser {
  /** uid Firebase du compte. */
  id: string;
  email: string | null;
}

/**
 * GET /api/auth/session : toujours 200.
 * En mode « firebase », toutes les routes /api/projects… exigent l'en-tête
 * `Authorization: Bearer <jeton d'identification Firebase>` (401 UNAUTHORIZED sinon),
 * et le projet d'un autre compte répond 404. Exception : les liens urls.source et
 * urls.download, signés, s'ouvrent sans en-tête (lecteur vidéo, téléchargement).
 */
export interface AuthSessionResponse {
  mode: AuthMode;
  /** Projet Firebase attendu par le serveur ; null en mode « none ». */
  firebaseProjectId: string | null;
  /** Compte reconnu d'après l'en-tête Authorization ; null sans jeton valide ou en mode « none ». */
  user: AuthUser | null;
}

/** POST /api/projects : corps vide. Réponse 201. */
export interface CreateProjectResponse {
  project: Project;
}

/** POST /api/projects/:id/upload : multipart/form-data, fichier dans le champ UPLOAD_RULES.fieldName. Réponse 200. */
export interface UploadSourceResponse {
  project: Project;
}

/** GET /api/projects/:id/status ; également renvoyé (202) par POST /api/projects/:id/analyze. */
export interface ProjectStatusResponse {
  projectId: string;
  revision: number;
  sourceUploaded: boolean;
  analysis: { status: AnalysisStatus; stage: AnalysisStage | null; error: ErrorInfo | null };
  render: { status: RenderStatus; progress: number; error: ErrorInfo | null };
}

/** GET /api/projects/:id */
export interface GetProjectResponse {
  project: Project;
}

/** GET /api/projects/:id/suggestions */
export interface SuggestionsResponse {
  projectId: string;
  revision: number;
  visualAnalysisAvailable: boolean;
  brollItems: BrollItem[];
  timeline: Timeline;
}

/** Champs d'un BrollItem modifiables par l'utilisateur ; tous les autres sont en lecture seule. */
export const EDITABLE_BROLL_FIELDS = [
  'startSeconds',
  'endSeconds',
  'selectedCandidateId',
  'status',
  'fit',
  'enabled',
] as const;

/** Modification partielle d'un BrollItem : seuls les champs présents changent. */
export interface BrollItemPatch {
  id: string;
  startSeconds?: number;
  endSeconds?: number;
  /** Doit désigner un candidat de cet élément. */
  selectedCandidateId?: string;
  status?: BrollItemStatus;
  fit?: BrollFit;
  enabled?: boolean;
}

/** PATCH /api/projects/:id/timeline : appliqué en entier ou pas du tout. */
export interface UpdateTimelineRequest {
  /** Révision sur laquelle le client s'est basé ; sinon 409 REVISION_CONFLICT. */
  baseRevision: number;
  items: BrollItemPatch[];
}

export interface UpdateTimelineResponse {
  project: Project;
}

/** POST /api/projects/:id/render */
export interface StartRenderRequest {
  /** Révision à exporter : doit être la révision actuelle (on exporte ce qui est affiché). */
  revision: number;
}

/** Réponse 202 : render.status vaut 'preparing'. */
export interface StartRenderResponse {
  render: RenderState;
}

/** GET /api/projects/:id/render/status */
export interface RenderStatusResponse {
  projectId: string;
  /** Révision actuelle du projet, à comparer avec render.revision. */
  projectRevision: number;
  render: RenderState;
}

/*
 * GET /api/projects/:id/download     → 200 video/mp4 (Content-Disposition: attachment), sinon ApiErrorResponse.
 * GET /api/projects/:id/media/source → vidéo source pour le lecteur (requêtes Range acceptées).
 */

// =====================================================================
// 6. Jobs de rendu : interface backend → worker (SQLite)
// =====================================================================
/*
 * Cycle de vie d'un job (table render_jobs) :
 *
 *   backend : POST /render → preparing → queued      (B-rolls téléchargés et vérifiés)
 *                                └─────→ failed      (RENDER_MEDIA_DOWNLOAD_FAILED, RENDER_INTERRUPTED)
 *   worker  : queued → rendering → completed         (MP4 validé par ffprobe)
 *                          ├─────→ failed            (erreur de rendu RENDER_*)
 *                          └─────→ queued | failed   (bail expiré : RENDER_JOB_SQL.recoverStale)
 *
 * - Le worker ne lit et n'écrit QUE render_jobs ; il n'accède ni à la table projects
 *   ni au réseau.
 * - Le worker reçoit un identifiant de job et un payload produit par le backend,
 *   jamais un chemin fourni par le client.
 * - Les deux processus ouvrent la même base (DATABASE_PATH) avec
 *   PRAGMA busy_timeout = 5000 ; le backend active journal_mode = WAL.
 *
 * RÈGLES DE RENDU (décision D-07, appliquées par le worker)
 * 1. La vidéo source est la base ; son audio est conservé (réencodé en AAC si
 *    nécessaire). L'audio des B-rolls n'est jamais utilisé.
 * 2. Pendant [startSeconds, endSeconds[, l'image affichée est celle du B-roll, lu
 *    depuis son début : l'instant 0 du média correspond à startSeconds.
 * 3. Cadrage. 'cover' : mise à l'échelle pour remplir l'image puis recadrage centré.
 *    'contain' : mise à l'échelle pour tout montrer puis bandes noires centrées.
 * 4. Le backend refuse un segment plus long que la durée annoncée du média choisi
 *    (TIMELINE_INVALID). Si le fichier réel est un peu plus court (durée Pixabay
 *    arrondie à la seconde), sa dernière image reste affichée jusqu'à endSeconds,
 *    comme un <video> HTML5 arrivé à la fin.
 * 5. Les segments sont triés, sans chevauchement et dans [0, source.durationSeconds] :
 *    garanti par le backend ; sinon le worker rejette le job (RENDER_INVALID_JOB).
 * 6. Instants alignés sur la frame de sortie la plus proche :
 *    Math.round(t * frameRate) / frameRate (1 frame ≈ 33,3 ms à 30 i/s).
 * 7. Sortie : MP4 H.264 (yuv420p) + AAC, faststart, durée égale à celle de la
 *    source à une frame près, dimensions output.width × output.height.
 */

export const RENDER_JOB_RULES = {
  /** Durée du bail d'un job 'rendering' sans signe de vie (ms). */
  leaseMs: 60_000,
  /** Fréquence de renouvellement du bail et de publication de la progression (ms). */
  heartbeatMs: 15_000,
  /** Tentatives maximales en cas de perte du worker. Une erreur de rendu ne relance pas le job. */
  maxAttempts: 2,
} as const;

/** Arborescence de stockage : <STORAGE_ROOT>/projects/<projectId>/<dossier>/… */
export const STORAGE_LAYOUT = {
  projectsDir: 'projects',
  /** Vidéo source importée. */
  sourceDir: 'source',
  /** B-rolls téléchargés pour l'export. */
  brollDir: 'broll',
  /** MP4 finaux validés. */
  outputDir: 'output',
  /** Fichiers temporaires (audio extrait, images, rendu en cours…). */
  workDir: 'work',
} as const;

/**
 * Chemin de fichier relatif au dossier du projet, généré par le backend.
 * Le worker vérifie ce motif ET que le chemin résolu reste dans le dossier du projet.
 */
export type ProjectRelativeFile = string;
export const PROJECT_RELATIVE_FILE_PATTERN = /^(source|broll|output)\/[A-Za-z0-9_-]{1,64}\.mp4$/;

/** B-roll à insérer, avec son média déjà présent sur le disque. */
export interface RenderSegment extends TimelineSegment {
  media: {
    /** Fichier téléchargé et vérifié par le backend : présent dès que le job est 'queued'. */
    file: ProjectRelativeFile;
    durationSeconds: number;
    width: number;
    height: number;
  };
}

/**
 * Contenu de render_jobs.payload (JSON) : instantané immuable du montage à la
 * révision render_jobs.project_revision. Modifier le projet ensuite n'affecte
 * pas un job existant.
 */
export interface RenderJobPayload {
  schemaVersion: SchemaVersion;
  source: {
    file: ProjectRelativeFile;
    durationSeconds: number;
    width: number;
    height: number;
    frameRate: number;
    audioPresent: boolean;
  };
  output: {
    /** Destination du MP4 final : le worker écrit un fichier temporaire, puis renomme après validation ffprobe. */
    file: ProjectRelativeFile;
    /**
     * Dimensions paires calculées par le backend : celles de la source, réduites si
     * besoin pour que le petit côté ≤ RENDER_MAX_SHORT_SIDE (720 ou 1080) et le grand
     * côté ≤ 16/9 de cette valeur, proportions conservées.
     */
    width: number;
    height: number;
    /** Celui de la source, plafonné à 60. */
    frameRate: number;
  };
  /** Triés par startSeconds, sans chevauchement, inclus dans [0, source.durationSeconds]. */
  segments: RenderSegment[];
}

/**
 * Ligne de la table render_jobs (noms des colonnes SQLite). Alias de type et non
 * interface : `stmt.get(...) as RenderJobRow | undefined` compile directement.
 */
export type RenderJobRow = {
  id: string;
  project_id: string;
  project_revision: number;
  status: RenderJobStatus;
  /** JSON d'un RenderJobPayload. */
  payload: string;
  progress: number;
  attempts: number;
  max_attempts: number;
  worker_id: string | null;
  lease_expires_at_ms: number | null;
  output_size_bytes: number | null;
  output_duration_seconds: number | null;
  error_code: ErrorCode | null;
  /** Message pour l'utilisateur (français, sans chemin ni sortie FFmpeg). */
  error_message: string | null;
  created_at_ms: number;
  updated_at_ms: number;
  started_at_ms: number | null;
  completed_at_ms: number | null;
};

/**
 * Création de la table (idempotente). Appliquée par le backend au démarrage ;
 * le worker et les tests peuvent l'exécuter aussi.
 */
export const RENDER_JOBS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS render_jobs (
  id                      TEXT    PRIMARY KEY,
  project_id              TEXT    NOT NULL,
  project_revision        INTEGER NOT NULL,
  status                  TEXT    NOT NULL
                          CHECK (status IN ('preparing', 'queued', 'rendering', 'completed', 'failed')),
  payload                 TEXT    NOT NULL,
  progress                REAL    NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  attempts                INTEGER NOT NULL DEFAULT 0,
  max_attempts            INTEGER NOT NULL DEFAULT 2,
  worker_id               TEXT,
  lease_expires_at_ms     INTEGER,
  output_size_bytes       INTEGER,
  output_duration_seconds REAL,
  error_code              TEXT,
  error_message           TEXT,
  created_at_ms           INTEGER NOT NULL,
  updated_at_ms           INTEGER NOT NULL,
  started_at_ms           INTEGER,
  completed_at_ms         INTEGER
);
CREATE INDEX IF NOT EXISTS render_jobs_status_idx  ON render_jobs (status, created_at_ms);
CREATE INDEX IF NOT EXISTS render_jobs_project_idx ON render_jobs (project_id, created_at_ms);
`;

/**
 * Requêtes de référence du worker. Paramètres nommés, préfixe « : » (avec
 * node:sqlite et better-sqlite3, passer un objet dont les clés n'ont pas de préfixe).
 * Toujours vérifier le nombre de lignes modifiées : 0 signifie que le worker
 * ne détient plus le job (bail perdu) et doit arrêter le rendu.
 */
export const RENDER_JOB_SQL = {
  /**
   * Prend le plus ancien job 'queued', si la limite de rendus simultanés le permet.
   * À exécuter DANS une transaction BEGIN IMMEDIATE … COMMIT. Renvoie 0 ou 1 ligne.
   * Paramètres : workerId, leaseExpiresAtMs, nowMs, maxConcurrentRenders.
   */
  claimNext: `
UPDATE render_jobs
   SET status              = 'rendering',
       worker_id           = :workerId,
       lease_expires_at_ms = :leaseExpiresAtMs,
       attempts            = attempts + 1,
       progress            = 0,
       started_at_ms       = :nowMs,
       updated_at_ms       = :nowMs,
       error_code          = NULL,
       error_message       = NULL
 WHERE id = (SELECT id FROM render_jobs
              WHERE status = 'queued'
              ORDER BY created_at_ms, id
              LIMIT 1)
   AND status = 'queued'
   AND (SELECT COUNT(*) FROM render_jobs
         WHERE status = 'rendering' AND lease_expires_at_ms >= :nowMs) < :maxConcurrentRenders
RETURNING *`,

  /**
   * Renouvelle le bail et publie la progression (toutes les RENDER_JOB_RULES.heartbeatMs).
   * Paramètres : jobId, workerId, progress (0 à 1), leaseExpiresAtMs, nowMs.
   */
  heartbeat: `
UPDATE render_jobs
   SET progress            = :progress,
       lease_expires_at_ms = :leaseExpiresAtMs,
       updated_at_ms       = :nowMs
 WHERE id = :jobId AND worker_id = :workerId AND status = 'rendering'`,

  /**
   * Termine le job, uniquement après validation ffprobe du fichier final.
   * Paramètres : jobId, workerId, outputSizeBytes, outputDurationSeconds, nowMs.
   */
  complete: `
UPDATE render_jobs
   SET status                  = 'completed',
       progress                = 1,
       output_size_bytes       = :outputSizeBytes,
       output_duration_seconds = :outputDurationSeconds,
       lease_expires_at_ms     = NULL,
       completed_at_ms         = :nowMs,
       updated_at_ms           = :nowMs
 WHERE id = :jobId AND worker_id = :workerId AND status = 'rendering'`,

  /**
   * Échec définitif (pas de nouvelle tentative).
   * Paramètres : jobId, workerId, errorCode (ErrorCode RENDER_*), errorMessage (français), nowMs.
   */
  fail: `
UPDATE render_jobs
   SET status              = 'failed',
       error_code          = :errorCode,
       error_message       = :errorMessage,
       lease_expires_at_ms = NULL,
       completed_at_ms     = :nowMs,
       updated_at_ms       = :nowMs
 WHERE id = :jobId AND worker_id = :workerId AND status = 'rendering'`,

  /**
   * Jobs 'rendering' dont le bail a expiré (worker arrêté ou planté) : remis en file
   * s'il reste des tentatives, sinon en échec RENDER_WORKER_LOST.
   * À exécuter au démarrage du worker et avant chaque claimNext. Paramètre : nowMs.
   */
  recoverStale: `
UPDATE render_jobs
   SET status              = CASE WHEN attempts < max_attempts THEN 'queued' ELSE 'failed' END,
       error_code          = CASE WHEN attempts < max_attempts THEN NULL ELSE 'RENDER_WORKER_LOST' END,
       error_message       = CASE WHEN attempts < max_attempts THEN NULL
                                  ELSE 'Le rendu a été interrompu à plusieurs reprises. Relancez l''export.' END,
       completed_at_ms     = CASE WHEN attempts < max_attempts THEN NULL ELSE :nowMs END,
       worker_id           = NULL,
       lease_expires_at_ms = NULL,
       updated_at_ms       = :nowMs
 WHERE status = 'rendering' AND lease_expires_at_ms < :nowMs`,
} as const;
