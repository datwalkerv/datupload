import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as sync } from "@/app/api/admin/sync/route";
import { GET as listFiles, POST as uploadFile } from "@/app/api/files/route";
import { callApi } from "@/lib/telegram/client";
import { FileModel } from "@/models/File";
import { installFakeTelegram, type FakeTelegram } from "../helpers/telegram";
import { setEnv } from "../helpers/setup";
import { authHeaders, BASE, pngBytes, uploadRequest } from "../helpers/request";

vi.mock("next/server", () => ({ connection: async () => {} }));

let tg: FakeTelegram;
beforeEach(() => {
  tg = installFakeTelegram();
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the upload budget is spent", async () => {
    setEnv({ RATE_LIMIT_UPLOADS_PER_MIN: "2" });
    const file = () => new Blob([pngBytes(100) as Uint8Array<ArrayBuffer>]);
    const headers = { ...authHeaders(), "x-forwarded-for": "203.0.113.7" };

    expect((await uploadFile(uploadRequest(file(), { headers }), undefined)).status).toBe(201);
    expect((await uploadFile(uploadRequest(file(), { headers }), undefined)).status).toBe(201);
    const limited = await uploadFile(uploadRequest(file(), { headers }), undefined);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await limited.json()).error.code).toBe("RATE_LIMITED");

    // Other clients and other buckets are unaffected.
    const other = { ...authHeaders(), "x-forwarded-for": "203.0.113.8" };
    expect((await uploadFile(uploadRequest(file(), { headers: other }), undefined)).status).toBe(201);
    const list = await listFiles(new Request(`${BASE}/api/files`, { headers }), undefined);
    expect(list.status).toBe(200);
  });

  it("also throttles requests with bad keys", async () => {
    setEnv({ RATE_LIMIT_REQUESTS_PER_MIN: "1" });
    const headers = { ...authHeaders("guess"), "x-forwarded-for": "198.51.100.1" };
    expect((await listFiles(new Request(`${BASE}/api/files`, { headers }), undefined)).status).toBe(401);
    expect((await listFiles(new Request(`${BASE}/api/files`, { headers }), undefined)).status).toBe(429);
  });
});

describe("Telegram client", () => {
  it("retries flood-wait responses using retry_after", async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return calls === 1
          ? Response.json({ ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } })
          : Response.json({ ok: true, result: { id: 1 } });
      }),
    );
    const promise = callApi("getMe");
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toEqual({ id: 1 });
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it("never includes the bot token in errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ok: false, error_code: 401, description: "Unauthorized" })));
    const error = (await callApi("getMe").catch((e: unknown) => e)) as Error;
    expect(String(error.message)).not.toContain("TEST_TOKEN");
  });
});

describe("POST /api/admin/sync", () => {
  const post = () => sync(new Request(`${BASE}/api/admin/sync`, { method: "POST", headers: authHeaders() }), undefined);
  const channel = { id: -1001234567890, type: "channel" };

  it("imports documents posted to the channel and skips the rest", async () => {
    tg.updates = [
      { update_id: 1, channel_post: { message_id: 10, date: 1_700_000_000, chat: channel, document: { file_id: "f1", file_unique_id: "u1", file_name: "report.pdf", mime_type: "application/pdf", file_size: 1234 } } },
      { update_id: 2, channel_post: { message_id: 11, date: 1_700_000_000, chat: channel, document: { file_id: "f2", file_unique_id: "u2", file_name: "huge.zip", file_size: 30 * 1024 * 1024 } } },
      { update_id: 3, channel_post: { message_id: 12, date: 1_700_000_000, chat: channel, photo: [{ file_id: "p", file_unique_id: "p" }] } },
      { update_id: 4, channel_post: { message_id: 13, date: 1_700_000_000, chat: { id: -100999, type: "channel" }, document: { file_id: "f3", file_unique_id: "u3" } } },
    ];

    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ imported: 1, skipped: { duplicate: 0, tooLarge: 1, unsupported: 1 } });

    const file = await FileModel.findOne({ filename: "report.pdf" }).lean();
    expect(file).toMatchObject({ status: "ready", source: "sync", size: 1234, contentType: "application/pdf", telegramMessageId: 10 });

    // Updates were acknowledged, so a second run finds nothing new.
    expect(await (await post()).json()).toMatchObject({ imported: 0 });
  });

  it("refuses to run while a webhook is set", async () => {
    tg.webhookUrl = "https://example.com/hook";
    expect((await post()).status).toBe(409);
  });
});

describe("GET /api/health", () => {
  it("reports connectivity without exposing configuration", async () => {
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(new Request(`${BASE}/api/health`));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ status: "ok", database: "connected", telegram: "connected" });
  });
});
