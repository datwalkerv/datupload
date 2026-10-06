import "server-only";
import { del, get, head, list } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { ApiError, errors } from "@/lib/errors";

/** Every staged upload lives under this prefix and is deleted once it reaches Telegram. */
export const STAGING_PREFIX = "staging/";
const TOKEN_TTL_MS = 15 * 60 * 1000;

function blobToken(): string {
  const token = env().blobToken;
  if (!token) {
    throw new ApiError(
      "STAGING_NOT_CONFIGURED",
      501,
      "Large uploads are not enabled on this server. Upload files up to the direct upload limit instead.",
    );
  }
  return token;
}

export function isStagingConfigured(): boolean {
  return Boolean(env().blobToken);
}

/** Issues a short-lived token that lets a client upload exactly one blob to `pathname`. */
export async function createStagingToken(filename: string, size: number) {
  const token = blobToken();
  const safeName = filename.replace(/[^\w.-]+/g, "_").slice(-100) || "file";
  const pathname = `${STAGING_PREFIX}${randomUUID()}/${safeName}`;
  const validUntil = Date.now() + TOKEN_TTL_MS;

  const clientToken = await generateClientTokenFromReadWriteToken({
    token,
    pathname,
    maximumSizeInBytes: Math.min(size, env().limits.maxFileSize),
    validUntil,
    addRandomSuffix: false,
    allowOverwrite: false,
  });

  return { pathname, clientToken, expiresAt: new Date(validUntil).toISOString() };
}

export function assertStagingPathname(pathname: string): void {
  if (
    !pathname.startsWith(STAGING_PREFIX) ||
    pathname.includes("..") ||
    !/^staging\/[0-9a-f-]{36}\/[\w.-]+$/.test(pathname)
  ) {
    throw errors.invalid("Invalid staging pathname.");
  }
}

export async function statStagedBlob(pathname: string) {
  try {
    return await head(pathname, { token: blobToken() });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("UPLOAD_NOT_FOUND", 404, "The staged upload does not exist or has expired.", undefined, {
      cause: error,
    });
  }
}

export async function openStagedBlob(pathname: string): Promise<ReadableStream<Uint8Array>> {
  const result = await get(pathname, { access: "private", token: blobToken(), useCache: false });
  if (!result || result.statusCode !== 200) {
    throw new ApiError("UPLOAD_NOT_FOUND", 404, "The staged upload does not exist or has expired.");
  }
  return result.stream;
}

export async function deleteStagedBlob(pathname: string): Promise<void> {
  try {
    await del(pathname, { token: blobToken() });
  } catch (error) {
    // The cleanup cron purges anything left behind.
    console.error(`[blob] could not delete staged blob ${pathname}`, error);
  }
}

/** Deletes staged blobs older than `maxAgeMs`. Returns how many were removed. */
export async function purgeStaleStagedBlobs(maxAgeMs: number): Promise<number> {
  if (!isStagingConfigured()) return 0;
  const token = blobToken();
  const cutoff = Date.now() - maxAgeMs;
  let cursor: string | undefined;
  let removed = 0;
  do {
    const page = await list({ prefix: STAGING_PREFIX, cursor, limit: 1000, token });
    const stale = page.blobs.filter((b) => b.uploadedAt.getTime() < cutoff).map((b) => b.url);
    if (stale.length > 0) {
      await del(stale, { token });
      removed += stale.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return removed;
}
