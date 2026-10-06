import { verifyApiKey, verifySignedUrl } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { errors } from "@/lib/errors";
import { readJson, requestOrigin, route } from "@/lib/http";
import { removeFile } from "@/lib/storage/remove";
import { serveFile } from "@/lib/storage/serve";
import { parseFileId, parseOrThrow, updateFileSchema } from "@/lib/validation/files";
import { FileModel, type FileRecord } from "@/models/File";
import { toFileDTO } from "@/types/file";

export const maxDuration = 300;

type Ctx = RouteContext<"/api/files/[id]">;

/**
 * GET /api/files/:id streams the file. `?download=false` serves previewable types inline.
 * HEAD returns the same headers without the body.
 */
async function download(request: Request, ctx: Ctx) {
  const id = parseFileId((await ctx.params).id);
  const params = new URL(request.url).searchParams;
  const inline = params.get("download") === "false";

  // Either an API key, or a signed URL from GET /api/files/:id/url.
  if (!verifyApiKey(request) && !verifySignedUrl(id, params, inline)) throw errors.unauthorized();

  await connectDb();
  const file = await FileModel.findOne({ _id: id, status: "ready" }).lean<FileRecord>();
  if (!file) throw errors.notFound();

  return serveFile(request, file, { inline, cacheControl: "private, max-age=3600" });
}

export const GET = route<Ctx>({ auth: "none" }, download);
export const HEAD = route<Ctx>({ auth: "none" }, download);

/** PATCH /api/files/:id  { public?: boolean } changes a file's visibility. */
export const PATCH = route<Ctx>({}, async (request, ctx) => {
  const id = parseFileId((await ctx.params).id);
  const body = parseOrThrow(updateFileSchema, await readJson(request));

  await connectDb();
  const file = await FileModel.findOneAndUpdate(
    { _id: id, status: "ready" },
    { $set: { public: body.public } },
    { returnDocument: "after" },
  ).lean<FileRecord>();
  if (!file) throw errors.notFound();

  return Response.json(toFileDTO(file, requestOrigin(request)));
});

/** DELETE /api/files/:id removes the Telegram messages, then the index record. */
export const DELETE = route<Ctx>({}, async (_request, ctx) => {
  const id = parseFileId((await ctx.params).id);

  await connectDb();
  // Marking it "deleting" hides the file immediately and lets a retry pick up where we left off.
  const file = await FileModel.findOneAndUpdate(
    { _id: id, status: { $in: ["ready", "deleting"] } },
    { $set: { status: "deleting" } },
    { returnDocument: "after" },
  ).lean<FileRecord>();
  if (!file) throw errors.notFound();

  const { telegramMessagesDeleted } = await removeFile(file);
  return Response.json({ id, deleted: true, telegramMessagesDeleted });
});
