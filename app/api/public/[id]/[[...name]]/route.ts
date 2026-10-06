import { connectDb } from "@/lib/db";
import { env } from "@/lib/env";
import { errors } from "@/lib/errors";
import { route } from "@/lib/http";
import { serveFile } from "@/lib/storage/serve";
import { parseFileId } from "@/lib/validation/files";
import { FileModel, type FileRecord } from "@/models/File";

export const maxDuration = 300;

type Ctx = RouteContext<"/api/public/[id]/[[...name]]">;

/**
 * GET /api/public/:id/:filename serves a public file with no authentication, e.g. as an
 * <img src>. The filename segment is cosmetic. Private and unknown files both return 404.
 *
 * Responses carry `s-maxage`, so Vercel's CDN caches them and Telegram is only contacted
 * on a cache miss. That also means making a file private, or deleting it, can take up to
 * PUBLIC_CACHE_MAX_AGE seconds to stop it being served from caches.
 */
async function servePublic(request: Request, ctx: Ctx) {
  const id = parseFileId((await ctx.params).id);

  await connectDb();
  const file = await FileModel.findOne({ _id: id, status: "ready", public: true }).lean<FileRecord>();
  if (!file) throw errors.notFound();

  const maxAge = env().publicCacheMaxAge;
  return serveFile(request, file, {
    inline: true,
    cacheControl: `public, max-age=${maxAge}, s-maxage=${maxAge}`,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  });
}

export const GET = route<Ctx>({ auth: "none" }, servePublic);
export const HEAD = route<Ctx>({ auth: "none" }, servePublic);
