import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { chunkStream, ingest } from "@/lib/storage/ingest";
import { FileModel } from "@/models/File";
import { installFakeTelegram, type FakeTelegram } from "./helpers/telegram";
import { setEnv } from "./helpers/setup";
import { pngBytes, streamOf } from "./helpers/request";

// CHUNK_SIZE_MB=0.01 → 10485-byte parts, so multi-part behaviour is cheap to test.
const SMALL_CHUNK = Math.floor(0.01 * 1024 * 1024);

let tg: FakeTelegram;
beforeEach(() => {
  tg = installFakeTelegram();
});

describe("chunkStream", () => {
  it("re-chunks arbitrary input into fixed-size parts", async () => {
    const bytes = pngBytes(25);
    const parts: number[] = [];
    for await (const part of chunkStream(streamOf(bytes, 7), 10, 100)) parts.push(part.byteLength);
    expect(parts).toEqual([10, 10, 5]);
  });

  it("aborts once the maximum size is exceeded", async () => {
    const consume = async () => {
      for await (const _ of chunkStream(streamOf(pngBytes(50), 8), 10, 20)) void _;
    };
    await expect(consume()).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
  });
});

describe("ingest", () => {
  it("stores a small file as a single Telegram document and indexes it", async () => {
    const bytes = pngBytes(5000);
    const record = await ingest({ stream: streamOf(bytes), filename: "image.png", declaredType: "image/png", folder: "projects" });

    expect(record.status).toBe("ready");
    expect(record.size).toBe(5000);
    expect(record.contentType).toBe("image/png");
    expect(record.folder).toBe("projects");
    expect(record.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(record.parts).toHaveLength(1);
    expect(record.telegramFileId).toBe(record.parts[0].telegramFileId);
    expect(record.telegramChannelId).toBe("-1001234567890");

    const sends = tg.calls.filter((c) => c.method === "sendDocument");
    expect(sends).toHaveLength(1);
    expect(sends[0].body).toMatchObject({ chat_id: "-1001234567890", disable_content_type_detection: "true" });
    expect((sends[0].body as { document: File }).document.name).toBe("image.png");

    const saved = await FileModel.findById(record._id).lean();
    expect(saved?.status).toBe("ready");
    expect(saved?.parts[0].telegramMessageId).toBe(record.telegramMessageId);
  });

  it("splits large files into ordered parts", async () => {
    setEnv({ CHUNK_SIZE_MB: "0.01" });
    const bytes = pngBytes(SMALL_CHUNK * 2 + 123);
    const record = await ingest({ stream: streamOf(bytes, 4096), filename: "big.png" });

    expect(record.parts.map((p) => p.size)).toEqual([SMALL_CHUNK, SMALL_CHUNK, 123]);
    expect(record.parts.map((p) => p.index)).toEqual([0, 1, 2]);
    const names = tg.calls.filter((c) => c.method === "sendDocument").map((c) => (c.body as { document: File }).document.name);
    expect(names).toEqual(["big.png.part001", "big.png.part002", "big.png.part003"]);

    const stored = record.parts.map((p) => tg.messages.get(p.telegramMessageId)!.bytes);
    expect(Buffer.concat(stored)).toEqual(Buffer.from(bytes));
  });

  it("rolls back sent parts and the record when Telegram fails mid-upload", async () => {
    setEnv({ CHUNK_SIZE_MB: "0.01" });
    tg.failSendAfter = 1;

    const error = await ingest({ stream: streamOf(pngBytes(SMALL_CHUNK * 3)), filename: "big.png" }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.code).toBe("TELEGRAM_UPLOAD_FAILED");

    expect(tg.messages.size).toBe(0); // the first part was deleted again
    expect(await FileModel.countDocuments()).toBe(0);
  });

  it("rejects empty files and mismatched content types without touching Telegram", async () => {
    await expect(ingest({ stream: streamOf(new Uint8Array()), filename: "a.png" })).rejects.toMatchObject({ status: 400 });
    const pdf = new TextEncoder().encode("%PDF-1.4 fake");
    await expect(ingest({ stream: streamOf(pdf), filename: "a.png", declaredType: "image/png" })).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE_TYPE",
    });
    expect(tg.calls).toHaveLength(0);
    expect(await FileModel.countDocuments()).toBe(0);
  });

  it("enforces the maximum size while streaming", async () => {
    setEnv({ MAX_FILE_SIZE_MB: "0.01", CHUNK_SIZE_MB: "0.005" });
    const error = await ingest({ stream: streamOf(pngBytes(SMALL_CHUNK + 10), 1024), filename: "a.png" }).catch((e) => e);
    expect(error.status).toBe(413);
    expect(tg.messages.size).toBe(0);
    expect(await FileModel.countDocuments()).toBe(0);
  });
});
