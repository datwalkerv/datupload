import { getBearerToken, safeEqual, verifyApiKey } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { env } from "@/lib/env";
import { errors } from "@/lib/errors";
import { route } from "@/lib/http";
import { purgeStaleStagedBlobs } from "@/lib/storage/blob";
import { removeFile } from "@/lib/storage/remove";
import { FileModel, type FileRecord } from "@/models/File";

export const maxDuration = 300;

const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * GET /api/admin/cleanup is run daily by Vercel Cron (see vercel.json), which sends
 * `Authorization: Bearer $CRON_SECRET`. The storage API key is accepted too.
 *
 * - Deletes staged blobs older than an hour (abandoned large uploads).
 * - Finishes interrupted uploads and deletes: records stuck in "uploading" or "deleting"
 *   have their Telegram parts removed, then the record itself.
 */
export const GET = route({ auth: "none", rateLimit: false }, async (request) => {
  const token = getBearerToken(request);
  const cronSecret = env().cronSecret;
  const isCron = Boolean(cronSecret && token && safeEqual(token, cronSecret));
  if (!isCron && !verifyApiKey(request)) throw errors.unauthorized();

  const stagedBlobsDeleted = await purgeStaleStagedBlobs(STALE_AFTER_MS);

  await connectDb();
  const stale = await FileModel.find({
    status: { $in: ["uploading", "deleting"] },
    updatedAt: { $lt: new Date(Date.now() - STALE_AFTER_MS) },
  })
    .limit(100)
    .lean<FileRecord[]>();

  let recordsRemoved = 0;
  for (const file of stale) {
    try {
      await removeFile(file);
      recordsRemoved++;
    } catch (error) {
      console.error(`[cleanup] could not remove ${file._id}`, error);
    }
  }

  return Response.json({ stagedBlobsDeleted, recordsRemoved });
});
