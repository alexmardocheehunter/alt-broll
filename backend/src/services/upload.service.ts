import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import multer from 'multer';
import type { AppConfig } from '../config/env.ts';
import { STORAGE_LAYOUT, UPLOAD_RULES, type ErrorCode, type Project, type SourceVideo } from '../contract.ts';
import { FfprobeUnavailableError, probeVideo, type VideoProbe } from '../media/ffprobe.ts';
import type { ProjectRecord } from '../repositories/project.repository.ts';
import type { LocalStorage } from '../storage/local-storage.ts';
import { AppError } from '../utils/errors.ts';
import type { Logger } from '../utils/logger.ts';
import { initialAnalysis, type ProjectService } from './project.service.ts';

/** Codecs vidéo acceptés en bêta (D-08, à confirmer) : lisibles par tous les navigateurs en preview. */
export const ACCEPTED_VIDEO_CODECS: readonly string[] = ['h264'];

/** Types déclarés tolérés : celui des navigateurs et celui des clients génériques (curl…). Le contenu est vérifié ensuite. */
const ACCEPTED_DECLARED_MIME_TYPES: readonly string[] = ['video/mp4', 'application/octet-stream'];

/** Marge pour les en-têtes multipart au-delà de la taille maximale du fichier. */
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const MAX_ORIGINAL_NAME_LENGTH = 200;
const BYTES_PER_MB = 1024 * 1024;

export interface UploadService {
  /** Reçoit, vérifie (extension, type, signature MP4, ffprobe) puis range la vidéo source du projet. */
  uploadSource(projectId: string, req: Request, res: Response): Promise<Project>;
}

export interface UploadServiceDeps {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly storage: LocalStorage;
  readonly projects: ProjectService;
}

export function createUploadService({ config, logger, storage, projects }: UploadServiceDeps): UploadService {
  const { maxUploadBytes, minVideoDurationSeconds, maxVideoDurationSeconds } = config.limits;
  /** Fichier temporaire de chaque requête, pour le supprimer quoi qu'il arrive. */
  const tmpFiles = new WeakMap<Request, string>();

  const receiveSingleFile = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, callback) => {
        mkdir(storage.uploadTmpDir, { recursive: true }).then(
          () => callback(null, storage.uploadTmpDir),
          (error: Error) => callback(error, storage.uploadTmpDir),
        );
      },
      filename: (req, _file, callback) => {
        const name = `${randomUUID()}.upload`;
        tmpFiles.set(req, path.join(storage.uploadTmpDir, name));
        callback(null, name);
      },
    }),
    // Les navigateurs envoient le nom de fichier en UTF-8 (« présentation.mp4 »).
    defParamCharset: 'utf8',
    limits: { fileSize: maxUploadBytes, files: 1, fields: 10, parts: 12, headerPairs: 100 },
    fileFilter: (_req, file, callback) => {
      const problem = declaredFileProblem(file);
      if (problem === null) callback(null, true);
      else callback(problem);
    },
  }).single(UPLOAD_RULES.fieldName);

  function tooLarge(): AppError {
    return uploadError(
      'UPLOAD_TOO_LARGE',
      413,
      `La vidéo dépasse la taille maximale autorisée (${Math.round(maxUploadBytes / BYTES_PER_MB)} Mo).`,
    );
  }

  function receiveFile(req: Request, res: Response): Promise<Express.Multer.File> {
    return new Promise((resolve, reject) => {
      receiveSingleFile(req, res, (error?: unknown) => {
        if (error !== undefined && error !== null) {
          reject(toUploadError(error, tooLarge));
          return;
        }
        if (req.file === undefined) {
          reject(
            uploadError(
              'UPLOAD_MISSING_FILE',
              400,
              `Aucune vidéo reçue : envoyez le fichier dans le champ « ${UPLOAD_RULES.fieldName} ».`,
            ),
          );
          return;
        }
        resolve(req.file);
      });
    });
  }

  function assertUploadAllowed(record: ProjectRecord): void {
    const { status } = record.document.analysis;
    if (status === 'queued' || status === 'processing') {
      throw conflict("Une analyse est en cours : attendez qu'elle se termine avant d'importer une autre vidéo.");
    }
    if (projects.hasActiveRender(record.id)) {
      throw conflict("Un export est en cours : attendez qu'il se termine avant de remplacer la vidéo.");
    }
  }

  /** Refus immédiat, sans recevoir le fichier, si la taille annoncée dépasse déjà la limite. */
  function assertDeclaredLengthAcceptable(req: Request): void {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxUploadBytes + MULTIPART_OVERHEAD_BYTES) throw tooLarge();
  }

  async function probeUploadedFile(filePath: string): Promise<VideoProbe> {
    try {
      return await probeVideo(config.binaries.ffprobe, filePath);
    } catch (error) {
      if (error instanceof FfprobeUnavailableError) {
        throw new AppError({
          code: 'INTERNAL_ERROR',
          stage: 'upload',
          httpStatus: 503,
          retryable: true,
          message: 'La vérification des vidéos est momentanément indisponible. Réessayez plus tard.',
          cause: error,
        });
      }
      throw new AppError({
        code: 'VIDEO_UNREADABLE',
        stage: 'upload',
        httpStatus: 422,
        message: 'Cette vidéo est illisible ou endommagée.',
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  function toSourceVideo(probe: VideoProbe, file: Express.Multer.File, storedFileName: string): SourceVideo {
    if (!probe.formatName.split(',').includes('mp4')) {
      throw uploadError('UPLOAD_UNSUPPORTED_TYPE', 415, "Ce fichier n'est pas une vidéo MP4.");
    }
    const { video, audio, durationSeconds } = probe;
    if (video === null) throw uploadError('VIDEO_NO_VIDEO_STREAM', 422, 'Ce fichier ne contient pas de piste vidéo.');
    if (durationSeconds === null || video.width <= 0 || video.height <= 0 || video.frameRate <= 0) {
      throw uploadError('VIDEO_UNREADABLE', 422, 'Cette vidéo est illisible ou endommagée.');
    }
    if (durationSeconds < minVideoDurationSeconds) {
      throw uploadError(
        'VIDEO_TOO_SHORT',
        422,
        `La vidéo dure ${describeDuration(durationSeconds, minVideoDurationSeconds)} ; la durée minimale est de ${describeDuration(minVideoDurationSeconds, durationSeconds)}.`,
      );
    }
    if (durationSeconds > maxVideoDurationSeconds) {
      throw uploadError(
        'VIDEO_TOO_LONG',
        422,
        `La vidéo dure ${describeDuration(durationSeconds, maxVideoDurationSeconds)} ; la limite de la bêta est de ${describeDuration(maxVideoDurationSeconds, durationSeconds)}.`,
      );
    }
    if (!ACCEPTED_VIDEO_CODECS.includes(video.codec)) {
      throw uploadError(
        'VIDEO_UNSUPPORTED_CODEC',
        422,
        `Le codec vidéo « ${video.codec} » n'est pas pris en charge : exportez la vidéo en MP4 H.264.`,
      );
    }
    if (audio === null) {
      throw uploadError(
        'VIDEO_NO_AUDIO',
        422,
        "Cette vidéo n'a pas de piste audio : ALT B-ROLL a besoin de la parole pour proposer des plans de coupe.",
      );
    }
    return {
      originalName: sanitizeOriginalName(file.originalname),
      storedFileName,
      mimeType: 'video/mp4',
      sizeBytes: file.size,
      durationSeconds,
      width: video.width,
      height: video.height,
      frameRate: video.frameRate,
      videoCodec: video.codec,
      audioPresent: true,
      audioCodec: audio.codec,
    };
  }

  async function removePreviousSource(record: ProjectRecord): Promise<void> {
    const previous = record.document.source;
    if (previous === null) return;
    try {
      const file = storage.resolveProjectFile(record.id, `${STORAGE_LAYOUT.sourceDir}/${previous.storedFileName}`);
      await rm(file, { force: true });
    } catch (error) {
      logger.warn('upload.previous_source_not_removed', { projectId: record.id, err: error });
    }
  }

  async function uploadSource(projectId: string, req: Request, res: Response): Promise<Project> {
    const record = projects.requireRecord(projectId);
    assertUploadAllowed(record);
    assertDeclaredLengthAcceptable(req);

    try {
      const file = await receiveFile(req, res);
      if (!(await hasMp4Signature(file.path))) {
        throw uploadError('UPLOAD_UNSUPPORTED_TYPE', 415, "Ce fichier n'est pas une vidéo MP4.");
      }
      const storedFileName = `${randomUUID()}.mp4`;
      const source = toSourceVideo(await probeUploadedFile(file.path), file, storedFileName);

      const destination = storage.resolveProjectFile(record.id, `${STORAGE_LAYOUT.sourceDir}/${storedFileName}`);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(file.path, destination);

      let saved: ProjectRecord;
      try {
        // Nouvelle vidéo : la transcription, l'analyse et les B-rolls précédents ne valent plus.
        saved = projects.save(record, { source, transcript: null, analysis: initialAnalysis(), brollItems: [] });
      } catch (error) {
        await rm(destination, { force: true });
        throw error;
      }
      await removePreviousSource(record);

      logger.info('upload.accepted', {
        projectId: record.id,
        sizeBytes: source.sizeBytes,
        durationSeconds: source.durationSeconds,
        width: source.width,
        height: source.height,
      });
      return projects.toProject(saved);
    } finally {
      const tmpFile = tmpFiles.get(req);
      if (tmpFile !== undefined) await rm(tmpFile, { force: true });
    }
  }

  return { uploadSource };
}

function uploadError(code: ErrorCode, httpStatus: number, message: string): AppError {
  return new AppError({ code, stage: 'upload', httpStatus, message });
}

function conflict(message: string): AppError {
  return new AppError({ code: 'CONFLICT', stage: 'upload', httpStatus: 409, retryable: true, message });
}

/** Contrôle du nom et du type annoncés, avant d'écrire quoi que ce soit sur le disque. */
function declaredFileProblem(file: Express.Multer.File): AppError | null {
  const extension = path.extname(file.originalname).toLowerCase();
  if (!(UPLOAD_RULES.acceptedExtensions as readonly string[]).includes(extension)) {
    return uploadError('UPLOAD_UNSUPPORTED_TYPE', 415, 'Seuls les fichiers MP4 (.mp4) sont acceptés.');
  }
  if (!ACCEPTED_DECLARED_MIME_TYPES.includes(file.mimetype.toLowerCase())) {
    return uploadError('UPLOAD_UNSUPPORTED_TYPE', 415, 'Le type du fichier ne correspond pas à une vidéo MP4.');
  }
  return null;
}

/** Erreurs de multer et de l'analyse multipart, traduites en erreurs du contrat. */
function toUploadError(error: unknown, tooLarge: () => AppError): unknown {
  if (error instanceof AppError) return error;
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') return tooLarge();
    if (error.code === 'LIMIT_UNEXPECTED_FILE' || error.code === 'LIMIT_FILE_COUNT') {
      return uploadError('UPLOAD_MISSING_FILE', 400, `Envoyez une seule vidéo, dans le champ « ${UPLOAD_RULES.fieldName} ».`);
    }
    return uploadError('BAD_REQUEST', 400, "Le formulaire d'envoi est invalide.");
  }
  if (error instanceof Error && /unexpected end of form/i.test(error.message)) {
    return new AppError({
      code: 'UPLOAD_INTERRUPTED',
      stage: 'upload',
      httpStatus: 400,
      retryable: true,
      message: "L'envoi de la vidéo a été interrompu. Réessayez.",
      cause: error,
    });
  }
  if (error instanceof Error && /multipart|boundary|malformed/i.test(error.message)) {
    return uploadError('BAD_REQUEST', 400, "Le formulaire d'envoi est invalide.");
  }
  // Erreur inattendue (disque plein…) : réponse 500 générique, détail dans les logs.
  return error;
}

/** Signature des conteneurs ISO (MP4) : boîte « ftyp » à l'octet 4. */
async function hasMp4Signature(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r');
  try {
    const head = Buffer.alloc(12);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return bytesRead >= 8 && head.toString('latin1', 4, 8) === 'ftyp';
  } finally {
    await handle.close();
  }
}

/** Nom d'affichage : sans dossier, sans caractère de contrôle, longueur bornée. */
export function sanitizeOriginalName(name: string): string {
  const baseName = name.split(/[\\/]/).pop() ?? '';
  const cleaned = baseName.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (cleaned === '' ? 'video.mp4' : cleaned).slice(0, MAX_ORIGINAL_NAME_LENGTH);
}

/** "4 min 12 s", "45 s" ; une décimale si l'arrondi rendait la valeur identique à `comparedTo`. */
export function describeDuration(seconds: number, comparedTo: number): string {
  const rounded = formatDuration(seconds);
  if (rounded !== formatDuration(comparedTo)) return rounded;
  return `${seconds.toFixed(1).replace('.', ',')} s`;
}

function formatDuration(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  const minutes = Math.floor(rounded / 60);
  const seconds = rounded % 60;
  if (minutes === 0) return `${seconds} s`;
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}
