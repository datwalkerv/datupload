import "server-only";
import { unstable_rethrow } from "next/navigation";
import { requireApiKey } from "@/lib/auth";
import { env } from "@/lib/env";
import { errorResponse, errors } from "@/lib/errors";
import { rateLimiter } from "@/lib/rate-limit";

type Bucket = "upload" | "default";

interface RouteOptions {
  /** "apiKey" (default) requires a Bearer key; "none" leaves auth to the handler. */
  auth?: "apiKey" | "none";
  /** Rate-limit bucket, or false to skip. Defaults to "default". */
  rateLimit?: Bucket | false;
}

export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function enforceRateLimit(request: Request, bucket: Bucket): Promise<void> {
  const { uploadsPerMinute, requestsPerMinute } = env().rateLimit;
  const max = bucket === "upload" ? uploadsPerMinute : requestsPerMinute;
  // Keyed by client IP (not API key) so guessing keys is throttled too.
  const result = await rateLimiter.limit(`${bucket}:${clientIp(request)}`, max, 60_000);
  if (!result.allowed) throw errors.rateLimited(result.retryAfter);
}

/**
 * Wraps a route handler with rate limiting, API-key auth and consistent error responses.
 * Internal error details are logged server-side and never returned to the client.
 */
export function route<Ctx>(
  options: RouteOptions,
  handler: (request: Request, context: Ctx) => Promise<Response>,
) {
  return async (request: Request, context: Ctx): Promise<Response> => {
    try {
      if (options.rateLimit !== false) await enforceRateLimit(request, options.rateLimit ?? "default");
      if ((options.auth ?? "apiKey") === "apiKey") requireApiKey(request);
      return await handler(request, context);
    } catch (error) {
      unstable_rethrow(error); // let Next.js prerender bail-outs through
      return errorResponse(error);
    }
  };
}

/** Reads a JSON body, turning malformed JSON into a 400. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw errors.invalid("The request body must be valid JSON.");
  }
}

/** Absolute origin of this deployment, honouring proxy headers. */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/** RFC 6266 / 5987: an ASCII fallback plus the exact UTF-8 name. */
export function contentDisposition(type: "inline" | "attachment", filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
