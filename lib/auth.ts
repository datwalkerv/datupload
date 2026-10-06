import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { errors } from "@/lib/errors";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time string comparison. Hashing first makes both inputs the same length. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function getBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : null;
}

/** True when the request carries `Authorization: Bearer <STORAGE_API_KEY>`. */
export function verifyApiKey(request: Request): boolean {
  const token = getBearerToken(request);
  return token !== null && safeEqual(token, env().apiKey);
}

/** Throws a 401 ApiError unless the request carries a valid API key. */
export function requireApiKey(request: Request): void {
  if (!verifyApiKey(request)) throw errors.unauthorized();
}

/** Non-reversible identifier for an API key, used for rate-limit buckets and logs. */
export function apiKeyFingerprint(request: Request): string {
  const token = getBearerToken(request) ?? "anonymous";
  return sha256(token).toString("hex").slice(0, 16);
}

// --- Signed download URLs -------------------------------------------------

function signaturePayload(id: string, expires: number, inline: boolean) {
  return `${id}:${expires}:${inline ? "inline" : "attachment"}`;
}

export function signFileUrl(id: string, expires: number, inline: boolean): string {
  return createHmac("sha256", env().urlSigningSecret)
    .update(signaturePayload(id, expires, inline))
    .digest("base64url");
}

/**
 * Validates `?expires=<unix seconds>&signature=...`. The signature binds the file id,
 * the expiry and the inline/attachment disposition, so none of them can be altered.
 */
export function verifySignedUrl(id: string, params: URLSearchParams, inline: boolean): boolean {
  const signature = params.get("signature");
  const expires = Number(params.get("expires"));
  if (!signature || !Number.isInteger(expires)) return false;
  if (expires < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(signature, signFileUrl(id, expires, inline));
}
