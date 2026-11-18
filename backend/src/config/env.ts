import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/** Racine du projet ALT B-ROLL : le dossier qui contient .env, backend/ et shared/. */
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const RENDER_SHORT_SIDES = [720, 1080] as const;
export type RenderShortSide = (typeof RENDER_SHORT_SIDES)[number];

const BYTES_PER_MB = 1024 * 1024;
const IN_MEMORY_DATABASE = ':memory:';

/** Obligatoires quand NODE_ENV=production ; facultatives en développement et en test. */
const REQUIRED_IN_PRODUCTION = [
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'PIXABAY_API_KEY',
] as const;

const nonEmpty = () => z.string().trim().min(1);

const envSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  HOST: nonEmpty().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  APP_BASE_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
  FRONTEND_ORIGIN: nonEmpty().default('http://localhost:5500'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  DATABASE_PATH: nonEmpty().default('./backend/data/alt-broll.sqlite'),
  STORAGE_ROOT: nonEmpty().default('./storage'),
  FFMPEG_PATH: nonEmpty().default('ffmpeg'),
  FFPROBE_PATH: nonEmpty().default('ffprobe'),
  GROQ_API_KEY: nonEmpty().optional(),
  GROQ_TRANSCRIPTION_MODEL: nonEmpty().default('whisper-large-v3-turbo'),
  OPENROUTER_API_KEY: nonEmpty().optional(),
  OPENROUTER_MODEL: nonEmpty().optional(),
  PIXABAY_API_KEY: nonEmpty().optional(),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(2048).default(150),
  MIN_VIDEO_DURATION_SECONDS: z.coerce.number().min(1).max(3600).default(5),
  MAX_VIDEO_DURATION_SECONDS: z.coerce.number().min(1).max(3600).default(180),
  RENDER_MAX_SHORT_SIDE: z.coerce.number().pipe(z.literal(RENDER_SHORT_SIDES)).default(1080),
  RATE_LIMIT_WRITES_PER_HOUR: z.coerce.number().int().min(1).max(100_000).default(60),
  TRUST_PROXY: nonEmpty().optional(),
});

/** Réglage Express « trust proxy » : false, 'loopback' (tunnel sur la même machine) ou nombre de proxys. */
export type TrustProxySetting = false | 'loopback' | number;

export interface AppConfig {
  readonly nodeEnv: NodeEnv;
  readonly host: string;
  readonly port: number;
  /** URL publique du backend, sans / final. */
  readonly appBaseUrl: string;
  readonly frontendOrigins: readonly string[];
  /** Adresse IP réelle du client derrière un tunnel ou un proxy (limite de débit, logs). */
  readonly trustProxy: TrustProxySetting;
  readonly logLevel: LogLevel;
  readonly paths: {
    readonly projectRoot: string;
    /** Chemin absolu, ou ":memory:" (tests). */
    readonly databasePath: string;
    readonly storageRoot: string;
  };
  readonly binaries: { readonly ffmpeg: string; readonly ffprobe: string };
  readonly providers: {
    readonly groq: { readonly apiKey: string | undefined; readonly transcriptionModel: string };
    readonly openRouter: { readonly apiKey: string | undefined; readonly model: string | undefined };
    readonly pixabay: { readonly apiKey: string | undefined };
  };
  readonly limits: {
    readonly maxUploadBytes: number;
    readonly minVideoDurationSeconds: number;
    readonly maxVideoDurationSeconds: number;
    readonly renderMaxShortSide: RenderShortSide;
    /** Créations de projet, imports, analyses et exports par heure et par adresse IP. */
    readonly writesPerHour: number;
  };
}

/** Configuration invalide : le message liste les variables en cause, jamais leurs valeurs. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      [
        "Configuration invalide (fichier .env ou variables d'environnement) :",
        ...issues.map((issue) => `  - ${issue}`),
        'Modèle : .env.example à la racine du projet.',
      ].join('\n'),
    );
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Charge <racine>/.env s'il existe. Les variables déjà définies dans le shell
 * restent prioritaires. Renvoie le chemin chargé, ou null si le fichier est absent.
 */
export function loadDotEnvFile(projectRoot: string = PROJECT_ROOT): string | null {
  const file = path.join(projectRoot, '.env');
  if (!existsSync(file)) return null;
  process.loadEnvFile(file);
  return file;
}

/** Valide l'environnement et renvoie une configuration figée. Lève ConfigError sinon. */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot: string = PROJECT_ROOT,
): AppConfig {
  const parsed = envSchema.safeParse(pickKnownVariables(env));
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.map(String).join('.')} : ${issue.message}`),
    );
  }

  const values = parsed.data;
  const issues: string[] = [];
  const frontendOrigins = parseOrigins(values.FRONTEND_ORIGIN, issues);
  const trustProxy = parseTrustProxy(values.TRUST_PROXY, issues);

  if (values.MIN_VIDEO_DURATION_SECONDS >= values.MAX_VIDEO_DURATION_SECONDS) {
    issues.push('MIN_VIDEO_DURATION_SECONDS : doit être inférieure à MAX_VIDEO_DURATION_SECONDS');
  }
  if (values.NODE_ENV === 'production') {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (values[key] === undefined) issues.push(`${key} : obligatoire en production`);
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);

  return deepFreeze({
    nodeEnv: values.NODE_ENV,
    host: values.HOST,
    port: values.PORT,
    appBaseUrl: values.APP_BASE_URL.replace(/\/+$/, ''),
    frontendOrigins,
    trustProxy,
    logLevel: values.LOG_LEVEL,
    paths: {
      projectRoot,
      databasePath:
        values.DATABASE_PATH === IN_MEMORY_DATABASE
          ? IN_MEMORY_DATABASE
          : path.resolve(projectRoot, values.DATABASE_PATH),
      storageRoot: path.resolve(projectRoot, values.STORAGE_ROOT),
    },
    binaries: { ffmpeg: values.FFMPEG_PATH, ffprobe: values.FFPROBE_PATH },
    providers: {
      groq: { apiKey: values.GROQ_API_KEY, transcriptionModel: values.GROQ_TRANSCRIPTION_MODEL },
      openRouter: { apiKey: values.OPENROUTER_API_KEY, model: values.OPENROUTER_MODEL },
      pixabay: { apiKey: values.PIXABAY_API_KEY },
    },
    limits: {
      maxUploadBytes: values.MAX_UPLOAD_MB * BYTES_PER_MB,
      minVideoDurationSeconds: values.MIN_VIDEO_DURATION_SECONDS,
      maxVideoDurationSeconds: values.MAX_VIDEO_DURATION_SECONDS,
      renderMaxShortSide: values.RENDER_MAX_SHORT_SIDE,
      writesPerHour: values.RATE_LIMIT_WRITES_PER_HOUR,
    },
  });
}

/** Fournisseurs utilisables (clé présente, et modèle pour OpenRouter). Ne révèle aucune valeur. */
export function configuredProviders(config: AppConfig): {
  groq: boolean;
  openrouter: boolean;
  pixabay: boolean;
} {
  const { groq, openRouter, pixabay } = config.providers;
  return {
    groq: groq.apiKey !== undefined,
    openrouter: openRouter.apiKey !== undefined && openRouter.model !== undefined,
    pixabay: pixabay.apiKey !== undefined,
  };
}

/** Ne garde que les variables connues ; une valeur vide équivaut à une variable absente. */
function pickKnownVariables(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = env[key]?.trim();
    picked[key] = value === undefined || value === '' ? undefined : value;
  }
  return picked;
}

function parseOrigins(raw: string, issues: string[]): string[] {
  const origins = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  for (const origin of origins) {
    if (!isHttpOrigin(origin)) {
      issues.push(
        `FRONTEND_ORIGIN : « ${origin} » n'est pas une origine valide (ex. http://localhost:5500, sans chemin ni / final)`,
      );
    }
  }
  return origins;
}

/** « true » est refusé : faire confiance à tout proxy laisserait n'importe quel client choisir son adresse IP. */
function parseTrustProxy(raw: string | undefined, issues: string[]): TrustProxySetting {
  if (raw === undefined || raw === 'false') return false;
  if (raw === 'loopback') return 'loopback';
  if (/^[1-9]$/.test(raw)) return Number(raw);
  issues.push('TRUST_PROXY : valeurs possibles false, loopback (tunnel sur cette machine) ou un nombre de proxys de 1 à 9');
  return false;
}

function isHttpOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
  } catch {
    return false;
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
