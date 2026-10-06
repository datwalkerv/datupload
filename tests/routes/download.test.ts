import { beforeEach, describe, expect, it } from "vitest";
import { GET as download, HEAD as head } from "@/app/api/files/[id]/route";
import { GET as signedUrl } from "@/app/api/files/[id]/url/route";
import { ingest } from "@/lib/storage/ingest";
import { installFakeTelegram, type FakeTelegram } from "../helpers/telegram";
import { setEnv } from "../helpers/setup";
import { authHeaders, BASE, ctx, pngBytes, readAll, streamOf } from "../helpers/request";

let tg: FakeTelegram;
beforeEach(() => {
  tg = installFakeTelegram();
});

const get = (id: string, { query = "", headers = authHeaders() }: { query?: string; headers?: Record<string, string> } = {}) =>
  download(new Request(`${BASE}/api/files/${id}${query}`, { headers }), ctx({ id }));

async function store(size: number, filename = "photo.png") {
  const bytes = pngBytes(size);
  const record = await ingest({ stream: streamOf(bytes, 3000), filename });
  return { id: record._id.toString(), bytes, record };
}

describe("GET /api/files/:id", () => {
  it("streams the file with download headers", async () => {
    const { id, bytes, record } = await store(5000);
    const res = await get(id);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe("5000");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="photo.png"; filename*=UTF-8''photo.png`);
    expect(res.headers.get("etag")).toBe(`"${record.sha256}"`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await readAll(res)).toEqual(bytes);
  });

  it("reassembles multi-part files in order", async () => {
    setEnv({ CHUNK_SIZE_MB: "0.01" });
    const { id, bytes, record } = await store(30_000);
    expect(record.parts.length).toBe(3);
    expect(await readAll(await get(id))).toEqual(bytes);
  });

  it("serves byte ranges across part boundaries", async () => {
    setEnv({ CHUNK_SIZE_MB: "0.01" });
    const { id, bytes } = await store(30_000);
    const res = await get(id, { headers: { ...authHeaders(), range: "bytes=10000-21000" } });

    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10000-21000/30000");
    expect(res.headers.get("content-length")).toBe("11001");
    expect(await readAll(res)).toEqual(bytes.slice(10000, 21001));

    const suffix = await get(id, { headers: { ...authHeaders(), range: "bytes=-10" } });
    expect(await readAll(suffix)).toEqual(bytes.slice(-10));

    const bad = await get(id, { headers: { ...authHeaders(), range: "bytes=40000-" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe("bytes */30000");
  });

  it("serves previewable types inline only when asked", async () => {
    const { id } = await store(100);
    const res = await get(id, { query: "?download=false" });
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("never serves active content inline", async () => {
    const html = new TextEncoder().encode("<script>alert(1)</script>");
    const record = await ingest({ stream: streamOf(html), filename: "x.html" });
    const res = await get(record._id.toString(), { query: "?download=false" });
    expect(res.headers.get("content-type")).toBe("text/html");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("returns 304 when the ETag matches", async () => {
    const { id, record } = await store(100);
    const res = await get(id, { headers: { ...authHeaders(), "if-none-match": `"${record.sha256}"` } });
    expect(res.status).toBe(304);
  });

  it("returns 404 for unknown and malformed ids", async () => {
    for (const id of ["65f000000000000000000000", "not-an-id"]) {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("FILE_NOT_FOUND");
    }
  });

  it("requires authentication", async () => {
    const { id } = await store(100);
    expect((await get(id, { headers: {} })).status).toBe(401);
    expect((await get(id, { headers: authHeaders("nope") })).status).toBe(401);
  });

  it("returns 502 when Telegram can't provide the file", async () => {
    const { id } = await store(100);
    tg.failGetFile = true;
    const res = await get(id);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("TELEGRAM_DOWNLOAD_FAILED");
    expect(JSON.stringify(body)).not.toMatch(/too big/);
  });

  it("HEAD returns headers without a body", async () => {
    const { id } = await store(1234);
    const res = await head(new Request(`${BASE}/api/files/${id}`, { method: "HEAD", headers: authHeaders() }), ctx({ id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1234");
    expect(tg.calls.filter((c) => c.method === "getFile")).toHaveLength(0);
  });
});

describe("GET /api/files/:id/url", () => {
  it("returns a signed API URL that works without an API key", async () => {
    const { id, bytes } = await store(500);
    const res = await signedUrl(
      new Request(`${BASE}/api/files/${id}/url?download=false&expiresIn=600`, { headers: authHeaders() }),
      ctx({ id }),
    );
    expect(res.status).toBe(200);
    const { url, expiresAt } = await res.json();
    expect(url).toMatch(new RegExp(`^${BASE}/api/files/${id}\\?download=false&expires=\\d+&signature=`));
    expect(url).not.toMatch(/telegram|TEST_TOKEN/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    const query = url.slice(url.indexOf("?"));
    const viaSignature = await get(id, { query, headers: {} });
    expect(viaSignature.status).toBe(200);
    expect(viaSignature.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(await readAll(viaSignature)).toEqual(bytes);

    // Flipping the disposition invalidates the signature.
    const tampered = await get(id, { query: query.replace("download=false&", ""), headers: {} });
    expect(tampered.status).toBe(401);
  });

  it("returns 404 for unknown files", async () => {
    const id = "65f000000000000000000000";
    const res = await signedUrl(new Request(`${BASE}/api/files/${id}/url`, { headers: authHeaders() }), ctx({ id }));
    expect(res.status).toBe(404);
  });
});
