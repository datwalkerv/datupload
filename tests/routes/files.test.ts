import { beforeEach, describe, expect, it } from "vitest";
import { GET as listFiles, POST as uploadFile } from "@/app/api/files/route";
import { FileModel } from "@/models/File";
import { installFakeTelegram, type FakeTelegram } from "../helpers/telegram";
import { setEnv } from "../helpers/setup";
import { authHeaders, BASE, pngBytes, uploadRequest } from "../helpers/request";

let tg: FakeTelegram;
beforeEach(() => {
  tg = installFakeTelegram();
});

const png = (size = 2048) => new Blob([pngBytes(size) as Uint8Array<ArrayBuffer>], { type: "image/png" });

describe("POST /api/files", () => {
  it("uploads a file and returns its metadata", async () => {
    const res = await uploadFile(uploadRequest(png(), { filename: "image.png" }), undefined);
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body).toMatchObject({ filename: "image.png", contentType: "image/png", size: 2048, parts: 1, folder: null });
    expect(body.id).toMatch(/^[a-f0-9]{24}$/);
    expect(body.telegramFileId).toBeTruthy();
    expect(new Date(body.createdAt).toString()).not.toBe("Invalid Date");
    // Nothing that identifies the channel or bot leaks into responses.
    expect(JSON.stringify(body)).not.toMatch(/-1001234567890|TEST_TOKEN|telegram\.test/);

    const record = await FileModel.findById(body.id).lean();
    expect(record).toMatchObject({ status: "ready", filename: "image.png", size: 2048 });
  });

  it("honours filename, folder and contentType overrides", async () => {
    const res = await uploadFile(
      uploadRequest(png(), { filename: "x.bin", fields: { filename: "renamed.png", folder: "/projects/", contentType: "image/png" } }),
      undefined,
    );
    expect(await res.json()).toMatchObject({ filename: "renamed.png", folder: "projects", contentType: "image/png" });
  });

  it("rejects requests without a file", async () => {
    const res = await uploadFile(uploadRequest(null, { fields: { folder: "a" } }), undefined);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("FILE_REQUIRED");
  });

  it("rejects non-multipart bodies", async () => {
    const res = await uploadFile(
      new Request(`${BASE}/api/files`, { method: "POST", headers: { ...authHeaders(), "content-type": "application/json" }, body: "{}" }),
      undefined,
    );
    expect(res.status).toBe(400);
  });

  it("rejects files over the configured maximum", async () => {
    setEnv({ MAX_FILE_SIZE_MB: "0.001" });
    const res = await uploadFile(uploadRequest(png(4096)), undefined);
    expect(res.status).toBe(413);
    expect((await res.json()).error.code).toBe("FILE_TOO_LARGE");
    expect(tg.calls).toHaveLength(0);
  });

  it("rejects direct uploads over the direct-upload limit and points to the staged flow", async () => {
    setEnv({ DIRECT_UPLOAD_MAX_MB: "0.001" });
    const res = await uploadFile(uploadRequest(png(4096)), undefined);
    expect(res.status).toBe(413);
    expect((await res.json()).error.message).toContain("/api/files/uploads");
  });

  it("rejects missing or invalid API keys before touching storage", async () => {
    const res = await uploadFile(uploadRequest(png(), { headers: authHeaders("wrong") }), undefined);
    expect(res.status).toBe(401);
    expect(tg.calls).toHaveLength(0);
  });

  it("returns 502 without leaking details when Telegram fails", async () => {
    tg.failSendAfter = 0;
    const res = await uploadFile(uploadRequest(png()), undefined);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe("TELEGRAM_UPLOAD_FAILED");
    expect(body.error.message).not.toMatch(/Bad Request/);
    expect(await FileModel.countDocuments()).toBe(0);
  });
});

describe("GET /api/files", () => {
  async function seed() {
    for (const [name, folder] of [
      ["a-image.png", "projects"],
      ["b-image.png", "projects"],
      ["c-notes.png", "other"],
    ]) {
      await uploadFile(uploadRequest(png(), { filename: name, fields: { folder } }), undefined);
    }
  }

  const list = (query = "") =>
    listFiles(new Request(`${BASE}/api/files${query}`, { headers: authHeaders() }), undefined);

  it("lists files newest first with pagination", async () => {
    await seed();
    const body = await (await list("?limit=2")).json();
    expect(body.pagination).toEqual({ page: 1, limit: 2, total: 3 });
    expect(body.files.map((f: { filename: string }) => f.filename)).toEqual(["c-notes.png", "b-image.png"]);
    expect(Object.keys(body.files[0]).sort()).toEqual(["contentType", "createdAt", "filename", "folder", "id", "public", "publicUrl", "size"]);

    const page2 = await (await list("?limit=2&page=2")).json();
    expect(page2.files.map((f: { filename: string }) => f.filename)).toEqual(["a-image.png"]);
  });

  it("filters by folder and search, treating search as literal text", async () => {
    await seed();
    const byFolder = await (await list("?folder=projects")).json();
    expect(byFolder.pagination.total).toBe(2);

    const bySearch = await (await list("?search=IMAGE")).json();
    expect(bySearch.pagination.total).toBe(2);

    const regexy = await (await list("?search=.*")).json();
    expect(regexy.pagination.total).toBe(0);
  });

  it("hides files that are not ready", async () => {
    await seed();
    await FileModel.updateOne({ filename: "a-image.png" }, { status: "deleting" });
    expect((await (await list()).json()).pagination.total).toBe(2);
  });

  it("validates query parameters", async () => {
    expect((await list("?limit=1000")).status).toBe(400);
    expect((await list("?page=0")).status).toBe(400);
  });
});
