import { route, readJson } from "@/lib/http";
import { createStagingToken } from "@/lib/storage/blob";
import {
  assertExtensionAllowed,
  assertSize,
  normalizeFolder,
  parseOrThrow,
  sanitizeFilename,
  stagedUploadSchema,
} from "@/lib/validation/files";

/**
 * POST /api/files/uploads  { filename, size, contentType?, folder? }
 *
 * Step 1 of a large upload. Returns a short-lived Vercel Blob client token that allows
 * exactly one upload to `pathname`. The client uploads the bytes straight to Blob
 * (bypassing the 4.5 MB function body limit), then calls POST /api/files/complete.
 */
export const POST = route({ rateLimit: "upload" }, async (request) => {
  const body = parseOrThrow(stagedUploadSchema, await readJson(request));

  const filename = sanitizeFilename(body.filename);
  assertExtensionAllowed(filename);
  assertSize(body.size);
  normalizeFolder(body.folder); // validate early; the value is passed again on completion

  const { pathname, clientToken, expiresAt } = await createStagingToken(filename, body.size);
  return Response.json(
    {
      pathname,
      clientToken,
      expiresAt,
      complete: { method: "POST", url: "/api/files/complete", body: { pathname } },
    },
    { status: 201 },
  );
});
