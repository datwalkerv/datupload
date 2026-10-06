import { route } from "@/lib/http";
import { syncChannel } from "@/lib/storage/sync";

export const maxDuration = 60;

/**
 * POST /api/admin/sync: best-effort discovery of files posted to the channel outside
 * this API. See `syncChannel` for its (significant) Bot API limitations.
 */
export const POST = route({ rateLimit: "upload" }, async () => {
  return Response.json(await syncChannel());
});
