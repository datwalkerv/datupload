import { signFileUrl } from "@/lib/auth";
import { connectDb } from "@/lib/db";
import { errors } from "@/lib/errors";
import { requestOrigin, route } from "@/lib/http";
import { parseFileId, parseOrThrow, urlQuerySchema } from "@/lib/validation/files";
import { FileModel } from "@/models/File";

type Ctx = RouteContext<"/api/files/[id]/url">;

/**
 * GET /api/files/:id/url?expiresIn=3600&download=false
 * Returns a time-limited signed URL to this API (never to Telegram) that works without
 * an Authorization header, e.g. in an <img> tag or a browser address bar.
 */
export const GET = route<Ctx>({}, async (request, ctx) => {
  const id = parseFileId((await ctx.params).id);
  const query = parseOrThrow(urlQuerySchema, Object.fromEntries(new URL(request.url).searchParams));

  await connectDb();
  if (!(await FileModel.exists({ _id: id, status: "ready" }))) throw errors.notFound();

  const inline = query.download === "false";
  const expires = Math.floor(Date.now() / 1000) + query.expiresIn;
  const url = new URL(`/api/files/${id}`, requestOrigin(request));
  if (inline) url.searchParams.set("download", "false");
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", signFileUrl(id, expires, inline));

  return Response.json({ url: url.toString(), expiresAt: new Date(expires * 1000).toISOString() });
});
