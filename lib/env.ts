import "server-only";
import { z } from "zod";

const MB = 1024 * 1024;

/** Telegram's hosted Bot API only lets bots download files of up to 20 MB. */
export const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * MB;

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase().replace(/^\./, ""))
      .filter(Boolean),
  );

const positiveNumber = (fallback: number) =>
  z.coerce.number().positive().catch(fallback).default(fallback);

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHANNEL_ID: z.string().min(1),
  TELEGRAM_API_BASE_URL: z.url().default("https://api.telegram.org"),

  STORAGE_API_KEY: z.string().min(16, "must be at least 16 characters"),
  URL_SIGNING_SECRET: optionalString,

  MONGODB_URI: z.string().min(1),
  MONGODB_DB_NAME: z.string().min(1).default("telegram-storage"),

  BLOB_READ_WRITE_TOKEN: optionalString,
  CRON_SECRET: optionalString,

  MAX_FILE_SIZE_MB: positiveNumber(2000),
  CHUNK_SIZE_MB: positiveNumber(19),
  DIRECT_UPLOAD_MAX_MB: positiveNumber(4),

  PUBLIC_CACHE_MAX_AGE: z.coerce.number().int().min(0).catch(86400).default(86400),

  RATE_LIMIT_UPLOADS_PER_MIN: positiveNumber(20),
  RATE_LIMIT_REQUESTS_PER_MIN: positiveNumber(300),

  ALLOWED_EXTENSIONS: list,
  BLOCKED_EXTENSIONS: list,
});

export type Env = ReturnType<typeof parseEnv>;

function parseEnv(source: NodeJS.ProcessEnv) {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Only report variable names, never values.
    const names = [...new Set(result.error.issues.map((i) => i.path.join(".")))];
    throw new Error(`Invalid or missing environment variables: ${names.join(", ")}`);
  }
  const e = result.data;
  return {
    telegram: {
      token: e.TELEGRAM_BOT_TOKEN,
      channelId: e.TELEGRAM_CHANNEL_ID,
      apiBaseUrl: e.TELEGRAM_API_BASE_URL.replace(/\/+$/, ""),
    },
    apiKey: e.STORAGE_API_KEY,
    urlSigningSecret: e.URL_SIGNING_SECRET ?? e.STORAGE_API_KEY,
    mongo: { uri: e.MONGODB_URI, dbName: e.MONGODB_DB_NAME },
    blobToken: e.BLOB_READ_WRITE_TOKEN,
    cronSecret: e.CRON_SECRET,
    limits: {
      maxFileSize: Math.floor(e.MAX_FILE_SIZE_MB * MB),
      // A part must stay below Telegram's 20 MB getFile limit, or it could never be downloaded again.
      chunkSize: Math.floor(Math.min(e.CHUNK_SIZE_MB, 19) * MB),
      // Vercel rejects request bodies over 4.5 MB, so direct uploads stay below that.
      directUploadMax: Math.floor(Math.min(e.DIRECT_UPLOAD_MAX_MB, 4.5) * MB),
    },
    /** Seconds browsers and the CDN may cache public files. Also how long unpublishing can take to propagate. */
    publicCacheMaxAge: e.PUBLIC_CACHE_MAX_AGE,
    rateLimit: {
      uploadsPerMinute: Math.floor(e.RATE_LIMIT_UPLOADS_PER_MIN),
      requestsPerMinute: Math.floor(e.RATE_LIMIT_REQUESTS_PER_MIN),
    },
    extensions: { allowed: e.ALLOWED_EXTENSIONS, blocked: e.BLOCKED_EXTENSIONS },
  };
}

let cached: Env | undefined;

/** Parsed lazily on first use so `next build` doesn't need secrets. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}

/** Test helper: forget the parsed env so the next call re-reads process.env. */
export function resetEnv() {
  cached = undefined;
}
