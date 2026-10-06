import { connection } from "next/server";
import { getHealth } from "@/lib/health";
import { clientIp } from "@/lib/http";
import { rateLimiter } from "@/lib/rate-limit";

/** GET /api/health is public and reveals only connectivity, never configuration. */
export async function GET(request: Request) {
  await connection(); // always evaluate at request time, never at build time

  const limit = await rateLimiter.limit(`health:${clientIp(request)}`, 60, 60_000);
  if (!limit.allowed) {
    return Response.json(
      { error: { code: "RATE_LIMITED", message: "Too many requests. Try again later." } },
      { status: 429, headers: { "Retry-After": String(limit.retryAfter) } },
    );
  }

  const { status, database, telegram } = await getHealth();
  return Response.json(
    { status, database, telegram },
    { status: status === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
