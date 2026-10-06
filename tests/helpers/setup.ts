import mongoose from "mongoose";
import { afterAll, afterEach, beforeEach, inject, vi } from "vitest";
import { resetEnv } from "@/lib/env";
import { rateLimiter } from "@/lib/rate-limit";

export const API_KEY = "test-api-key-0123456789";

const baseEnv = {
  TELEGRAM_BOT_TOKEN: "123456:TEST_TOKEN",
  TELEGRAM_CHANNEL_ID: "-1001234567890",
  TELEGRAM_API_BASE_URL: "https://telegram.test",
  STORAGE_API_KEY: API_KEY,
  MONGODB_URI: inject("mongoUri"),
  // One database per test file so files can run in parallel.
  MONGODB_DB_NAME: `test-${Math.random().toString(36).slice(2)}`,
  BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_test_token",
  CRON_SECRET: "cron-secret-0123456789",
  MAX_FILE_SIZE_MB: "50",
  CHUNK_SIZE_MB: "19",
  DIRECT_UPLOAD_MAX_MB: "4",
  RATE_LIMIT_UPLOADS_PER_MIN: "1000",
  RATE_LIMIT_REQUESTS_PER_MIN: "1000",
};

Object.assign(process.env, baseEnv);

/** Override env vars for the current test; restored automatically afterwards. */
export function setEnv(overrides: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnv();
}

beforeEach(() => {
  Object.assign(process.env, baseEnv);
  delete process.env.ALLOWED_EXTENSIONS;
  delete process.env.BLOCKED_EXTENSIONS;
  resetEnv();
  rateLimiter.reset?.();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.db!.dropDatabase();
  }
});

afterAll(async () => {
  await mongoose.disconnect();
});
