import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as complete } from "@/app/api/files/complete/route";
import { POST as createUpload } from "@/app/api/files/uploads/route";
import { FileModel } from "@/models/File";
import { installFakeTelegram, type FakeTelegram } from "../helpers/telegram";
import { setEnv } from "../helpers/setup";
import { authHeaders, BASE, pngBytes, streamOf } from "../helpers/request";

const blob = vi.hoisted(() => ({
  bytes: new Uint8Array() as Uint8Array,
  del: vi.fn(async () => {}),
}));

vi.mock("@vercel/blob", () => ({
  head: vi.fn(async (pathname: string) => {
    if (!blob.bytes.length) throw new Error("BlobNotFoundError");
    return { size: blob.bytes.byteLength, pathname, contentType: "image/png", uploadedAt: new Date() };
  }),
  get: vi.fn(async () => ({ statusCode: 200, stream: streamOf(blob.bytes, 5000) })),
  del: blob.del,
  list: vi.fn(async () => ({ blobs: [], hasMore: false })),
}));

vi.mock("@vercel/blob/client", () => ({
  generateClientTokenFromReadWriteToken: vi.fn(async (opts: { pathname: string; maximumSizeInBytes: number }) =>
    `client-token:${opts.pathname}:${opts.maximumSizeInBytes}`,
  ),
}));

let tg: FakeTelegram;
beforeEach(() => {
  tg = installFakeTelegram();
  blob.bytes = new Uint8Array();
  blob.del.mockClear();
});

const post = (handler: typeof complete, path: string, body: unknown, headers = authHeaders()) =>
  handler(
    new Request(`${BASE}${path}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    undefined,
  );

const PATHNAME = "staging/0b5ef7a4-3a43-4c4f-9a4f-1f2a3b4c5d6e/video.png";

describe("POST /api/files/uploads", () => {
  it("issues a scoped client token for a staging pathname", async () => {
    const res = await post(createUpload, "/api/files/uploads", { filename: "My Video.png", size: 10_000_000 });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.pathname).toMatch(/^staging\/[0-9a-f-]{36}\/My_Video\.png$/);
    expect(body.clientToken).toBe(`client-token:${body.pathname}:10000000`);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("validates size, body and auth", async () => {
    setEnv({ MAX_FILE_SIZE_MB: "1" });
    expect((await post(createUpload, "/api/files/uploads", { filename: "a.png", size: 2 * 1024 * 1024 })).status).toBe(413);
    expect((await post(createUpload, "/api/files/uploads", { filename: "a.png" })).status).toBe(400);
    expect((await post(createUpload, "/api/files/uploads", { filename: "a.png", size: 1 }, {})).status).toBe(401);
  });

  it("returns 501 when Blob staging isn't configured", async () => {
    setEnv({ BLOB_READ_WRITE_TOKEN: undefined });
    const res = await post(createUpload, "/api/files/uploads", { filename: "a.png", size: 100 });
    expect(res.status).toBe(501);
    expect((await res.json()).error.code).toBe("STAGING_NOT_CONFIGURED");
  });
});

describe("POST /api/files/complete", () => {
  it("moves the staged blob into Telegram and deletes it", async () => {
    setEnv({ CHUNK_SIZE_MB: "0.01" });
    blob.bytes = pngBytes(25_000);

    const res = await post(complete, "/api/files/complete", { pathname: PATHNAME, filename: "vidéo.png", folder: "media" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ filename: "vidéo.png", folder: "media", size: 25_000, parts: 3, contentType: "image/png" });
    expect(tg.messages.size).toBe(3);
    expect(blob.del).toHaveBeenCalledWith(PATHNAME, expect.anything());
  });

  it("deletes the blob even when Telegram fails", async () => {
    blob.bytes = pngBytes(1000);
    tg.failSendAfter = 0;
    const res = await post(complete, "/api/files/complete", { pathname: PATHNAME });
    expect(res.status).toBe(502);
    expect(blob.del).toHaveBeenCalledOnce();
    expect(await FileModel.countDocuments()).toBe(0);
  });

  it("rejects pathnames outside the staging area", async () => {
    for (const pathname of ["other/file.png", "staging/../secret.png", "staging/abc/file.png"]) {
      const res = await post(complete, "/api/files/complete", { pathname });
      expect(res.status).toBe(400);
    }
    expect(blob.del).not.toHaveBeenCalled();
  });

  it("returns 404 for a missing staged blob", async () => {
    const res = await post(complete, "/api/files/complete", { pathname: PATHNAME });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("UPLOAD_NOT_FOUND");
  });
});
