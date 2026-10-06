import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listFiles, POST as uploadFile } from "@/app/api/files/route";
import { PATCH as updateFile } from "@/app/api/files/[id]/route";
import { POST as complete } from "@/app/api/files/complete/route";
import { GET as getPublic, HEAD as headPublic } from "@/app/api/public/[id]/[[...name]]/route";
import { installFakeTelegram, type FakeTelegram } from "../helpers/telegram";
import { setEnv } from "../helpers/setup";
import { authHeaders, BASE, ctx, pngBytes, readAll, streamOf, uploadRequest } from "../helpers/request";

const blob = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));
vi.mock("@vercel/blob", () => ({
  head: vi.fn(async (pathname: string) => ({ size: blob.bytes.byteLength, pathname, contentType: "image/png" })),
  get: vi.fn(async () => ({ statusCode: 200, stream: streamOf(blob.bytes) })),
  del: vi.fn(async () => {}),
  list: vi.fn(async () => ({ blobs: [], hasMore: false })),
}));

let tg: FakeTelegram;
beforeEach(() => {
  tg = installFakeTelegram();
});

const png = (size = 2048) => new Blob([pngBytes(size) as Uint8Array<ArrayBuffer>], { type: "image/png" });

async function upload(fields: Record<string, string> = {}, filename = "photo.png") {
  const res = await uploadFile(uploadRequest(png(), { filename, fields }), undefined);
  expect(res.status).toBe(201);
  return res.json();
}

/** Requests a public URL exactly as a browser would: no auth header. */
function fetchPublic(url: string, headers: Record<string, string> = {}, method = "GET") {
  const { pathname } = new URL(url);
  const [, , , id, ...name] = pathname.split("/");
  const handler = method === "HEAD" ? headPublic : getPublic;
  return handler(new Request(url, { method, headers }), { params: Promise.resolve({ id, name: name.map(decodeURIComponent) }) });
}

const patch = (id: string, body: unknown) =>
  updateFile(
    new Request(`${BASE}/api/files/${id}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx({ id }),
  );

describe("public files", () => {
  it("are private by default", async () => {
    const file = await upload();
    expect(file.public).toBe(false);
    expect(file.publicUrl).toBeNull();

    const res = await fetchPublic(`${BASE}/api/public/${file.id}/photo.png`);
    expect(res.status).toBe(404);
  });

  it("get a permanent URL that works without auth and is CDN-cacheable", async () => {
    const file = await upload({ public: "true" }, "My Photo é.png");
    expect(file.public).toBe(true);
    expect(file.publicUrl).toBe(`${BASE}/api/public/${file.id}/My%20Photo%20%C3%A9.png`);

    const res = await fetchPublic(file.publicUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400, s-maxage=86400");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(await readAll(res)).toEqual(pngBytes(2048));
  });

  it("support ETag revalidation, ranges and HEAD", async () => {
    const file = await upload({ public: "1" });
    const first = await fetchPublic(file.publicUrl);
    const etag = first.headers.get("etag")!;
    await first.body?.cancel();

    expect((await fetchPublic(file.publicUrl, { "if-none-match": etag })).status).toBe(304);

    const ranged = await fetchPublic(file.publicUrl, { range: "bytes=0-7" });
    expect(ranged.status).toBe(206);
    expect(await readAll(ranged)).toEqual(pngBytes(8));

    const head = await fetchPublic(file.publicUrl, {}, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("2048");
  });

  it("ignore the filename segment and work with the id alone", async () => {
    const file = await upload({ public: "true" });
    expect((await fetchPublic(`${BASE}/api/public/${file.id}/anything.jpg`)).status).toBe(200);
    expect((await fetchPublic(`${BASE}/api/public/${file.id}`)).status).toBe(200);
  });

  it("never render active content inline", async () => {
    const html = new Blob(["<script>alert(1)</script>"], { type: "text/html" });
    const res = await uploadFile(uploadRequest(html, { filename: "x.html", fields: { public: "true" } }), undefined);
    const file = await res.json();
    const served = await fetchPublic(file.publicUrl);
    expect(served.headers.get("content-disposition")).toMatch(/^attachment;/);
  });

  it("can be published and unpublished with PATCH", async () => {
    const file = await upload();

    const published = await (await patch(file.id, { public: true })).json();
    expect(published.publicUrl).toBe(`${BASE}/api/public/${file.id}/photo.png`);
    expect((await fetchPublic(published.publicUrl)).status).toBe(200);

    const unpublished = await (await patch(file.id, { public: false })).json();
    expect(unpublished).toMatchObject({ public: false, publicUrl: null });
    expect((await fetchPublic(published.publicUrl)).status).toBe(404);
  });

  it("PATCH validates input, auth and existence", async () => {
    const file = await upload();
    expect((await patch(file.id, { public: "yes" })).status).toBe(400);
    expect((await patch("65f000000000000000000000", { public: true })).status).toBe(404);
    const noAuth = await updateFile(
      new Request(`${BASE}/api/files/${file.id}`, { method: "PATCH", body: JSON.stringify({ public: true }) }),
      ctx({ id: file.id }),
    );
    expect(noAuth.status).toBe(401);
  });

  it("can be filtered in listings", async () => {
    await upload({ public: "true" }, "a.png");
    await upload({}, "b.png");
    const res = await listFiles(new Request(`${BASE}/api/files?public=true`, { headers: authHeaders() }), undefined);
    const body = await res.json();
    expect(body.files.map((f: { filename: string }) => f.filename)).toEqual(["a.png"]);
    expect(body.files[0].publicUrl).toMatch(/\/api\/public\/[a-f0-9]{24}\/a\.png$/);
  });

  it("can be created through the staged upload flow", async () => {
    blob.bytes = pngBytes(1000);
    const res = await complete(
      new Request(`${BASE}/api/files/complete`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ pathname: "staging/0b5ef7a4-3a43-4c4f-9a4f-1f2a3b4c5d6e/big.png", public: true }),
      }),
      undefined,
    );
    expect(res.status).toBe(201);
    expect((await res.json()).public).toBe(true);
  });

  it("use the configured cache lifetime", async () => {
    setEnv({ PUBLIC_CACHE_MAX_AGE: "60" });
    const file = await upload({ public: "true" });
    const res = await fetchPublic(file.publicUrl);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    expect(tg.calls.some((c) => c.method === "getFile")).toBe(true);
  });

  it("rejects an invalid public flag on upload", async () => {
    const res = await uploadFile(uploadRequest(png(), { fields: { public: "maybe" } }), undefined);
    expect(res.status).toBe(400);
  });
});
