import { readJson, requestOrigin, route } from "@/lib/http";
import {
  assertStagingPathname,
  deleteStagedBlob,
  openStagedBlob,
  statStagedBlob,
} from "@/lib/storage/blob";
import { ingest } from "@/lib/storage/ingest";
import { assertSize, completeUploadSchema, parseOrThrow } from "@/lib/validation/files";
import { toFileDTO } from "@/types/file";

// Large files are moved part by part; raise this on plans that allow longer functions.
export const maxDuration = 800;

/**
 * POST /api/files/complete  { pathname, filename?, folder?, contentType? }
 *
 * Step 2 of a large upload: streams the staged blob into Telegram, indexes it, and
 * deletes the blob. Blob is only ever a temporary staging area.
 */
export const POST = route({ rateLimit: "upload" }, async (request) => {
  const body = parseOrThrow(completeUploadSchema, await readJson(request));
  assertStagingPathname(body.pathname);

  const blob = await statStagedBlob(body.pathname);
  try {
    assertSize(blob.size);
    const record = await ingest({
      stream: await openStagedBlob(body.pathname),
      filename: body.filename ?? body.pathname.split("/").pop()!,
      declaredType: body.contentType ?? blob.contentType,
      folder: body.folder,
      public: body.public,
    });
    return Response.json(toFileDTO(record, requestOrigin(request)), { status: 201 });
  } finally {
    await deleteStagedBlob(body.pathname);
  }
});
