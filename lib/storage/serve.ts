import "server-only";
import { contentDisposition } from "@/lib/http";
import { openStoredFile, parseRange } from "@/lib/storage/stream";
import { isInlineSafe } from "@/lib/validation/sniff";
import type { FileRecord } from "@/models/File";

export interface ServeOptions {
  /** Serve previewable types inline instead of as an attachment. */
  inline: boolean;
  cacheControl: string;
  /** Extra headers, e.g. CORS for public files. */
  headers?: Record<string, string>;
}

function notModified(request: Request, file: FileRecord): boolean {
  const ifNoneMatch = request.headers.get("if-none-match");
  return Boolean(
    file.sha256 && ifNoneMatch?.split(",").some((t) => t.trim().replace(/^W\//, "") === `"${file.sha256}"`),
  );
}

/**
 * Builds the HTTP response for a stored file: content headers, ETag/304, single byte
 * ranges (206/416), HEAD, and a streamed body assembled from the Telegram parts.
 */
export async function serveFile(request: Request, file: FileRecord, options: ServeOptions): Promise<Response> {
  const disposition = options.inline && isInlineSafe(file.contentType) ? "inline" : "attachment";
  const headers = new Headers({
    "Content-Type": file.contentType,
    "Content-Disposition": contentDisposition(disposition, file.filename),
    "Accept-Ranges": "bytes",
    "Cache-Control": options.cacheControl,
    "X-Content-Type-Options": "nosniff",
    // Stored files are data, never an app running on our origin.
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
    ...(file.sha256 ? { ETag: `"${file.sha256}"` } : {}),
    ...options.headers,
  });

  if (notModified(request, file)) return new Response(null, { status: 304, headers });

  if (request.method === "HEAD") {
    headers.set("Content-Length", String(file.size));
    return new Response(null, { status: 200, headers });
  }

  const range = parseRange(request.headers.get("range"), file.size);
  if (range === "unsatisfiable") {
    return Response.json(
      { error: { code: "RANGE_NOT_SATISFIABLE", message: "The requested range is not satisfiable." } },
      { status: 416, headers: { "Content-Range": `bytes */${file.size}` } },
    );
  }

  const span = range ?? { start: 0, end: file.size - 1 };
  const body = await openStoredFile(file.parts, span, request.signal);

  headers.set("Content-Length", String(span.end - span.start + 1));
  if (range) headers.set("Content-Range", `bytes ${span.start}-${span.end}/${file.size}`);
  return new Response(body, { status: range ? 206 : 200, headers });
}
