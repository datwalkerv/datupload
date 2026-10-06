import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as deleteFile, GET as download } from "@/app/api/files/[id]/route";
import { GET as cleanup } from "@/app/api/admin/cleanup/route";
import { ingest } from "@/lib/storage/ingest";
import { FileModel } from "@/models/File";
import { installFakeTelegram, type FakeTelegram } from "../helpers/telegram";
import { setEnv } from "../helpers/setup";
import { authHeaders, BASE, ctx, pngBytes, streamOf } from "../helpers/request";

vi.mock("@/lib/storage/blob", () => ({ purgeStaleStagedBlobs: vi.fn(async () => 0) }));

let tg: FakeTelegram;
beforeEach(() => {
  tg = installFakeTelegram();
});

const del = (id: string, headers = authHeaders()) =>
  deleteFile(new Request(`${BASE}/api/files/${id}`, { method: "DELETE", headers }), ctx({ id }));

async function store(size = 1000) {
  const record = await ingest({ stream: streamOf(pngBytes(size)), filename: "photo.png" });
  return record;
}

describe("DELETE /api/files/:id", () => {
  it("deletes the Telegram messages and the record", async () => {
    setEnv({ CHUNK_SIZE_MB: "0.01" });
    const record = await store(25_000);
    const id = record._id.toString();
    expect(tg.messages.size).toBe(3);

    const res = await del(id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id, deleted: true, telegramMessagesDeleted: true });
    expect(tg.messages.size).toBe(0);
    expect(await FileModel.exists({ _id: id })).toBeNull();

    const after = await download(new Request(`${BASE}/api/files/${id}`, { headers: authHeaders() }), ctx({ id }));
    expect(after.status).toBe(404);
  });

  it("still cleans up MongoDB when the Telegram message is already gone", async () => {
    const record = await store();
    tg.messages.clear();

    const res = await del(record._id.toString());
    expect(res.status).toBe(200);
    expect((await res.json()).telegramMessagesDeleted).toBe(true);
    expect(await FileModel.countDocuments()).toBe(0);
  });

  it("removes the index entry but reports when Telegram refuses (e.g. older than 48h)", async () => {
    const record = await store();
    tg.undeletable.add(record.parts[0].telegramMessageId);

    const res = await del(record._id.toString());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deleted: true, telegramMessagesDeleted: false });
    expect(await FileModel.countDocuments()).toBe(0);
  });

  it("keeps a hidden, retryable record if MongoDB fails after Telegram succeeded", async () => {
    const record = await store();
    const id = record._id.toString();

    const spy = vi.spyOn(FileModel, "deleteOne").mockRejectedValueOnce(new Error("mongo down"));
    const res = await del(id);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("STORAGE_UNAVAILABLE");
    expect(tg.messages.size).toBe(0);
    expect((await FileModel.findById(id).lean())?.status).toBe("deleting");
    spy.mockRestore();

    // Hidden from downloads while in this state.
    const hidden = await download(new Request(`${BASE}/api/files/${id}`, { headers: authHeaders() }), ctx({ id }));
    expect(hidden.status).toBe(404);

    // Retrying finishes the job.
    const retry = await del(id);
    expect(retry.status).toBe(200);
    expect(await FileModel.countDocuments()).toBe(0);
  });

  it("returns 404 for unknown files and 401 without a key", async () => {
    expect((await del("65f000000000000000000000")).status).toBe(404);
    const record = await store();
    expect((await del(record._id.toString(), {})).status).toBe(401);
    expect(await FileModel.countDocuments()).toBe(1);
  });
});

describe("GET /api/admin/cleanup", () => {
  it("removes stale uploading/deleting records and their messages", async () => {
    const record = await store();
    const stale = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await FileModel.collection.updateOne({ _id: record._id }, { $set: { status: "uploading", updatedAt: stale } });
    const fresh = await store();
    await FileModel.updateOne({ _id: fresh._id }, { status: "uploading" });

    const res = await cleanup(
      new Request(`${BASE}/api/admin/cleanup`, { headers: { authorization: "Bearer cron-secret-0123456789" } }),
      undefined,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stagedBlobsDeleted: 0, recordsRemoved: 1 });
    expect(await FileModel.exists({ _id: record._id })).toBeNull();
    expect(await FileModel.exists({ _id: fresh._id })).not.toBeNull();
    expect(tg.messages.has(record.parts[0].telegramMessageId)).toBe(false);
  });

  it("requires the cron secret or API key", async () => {
    const res = await cleanup(new Request(`${BASE}/api/admin/cleanup`), undefined);
    expect(res.status).toBe(401);
  });
});
