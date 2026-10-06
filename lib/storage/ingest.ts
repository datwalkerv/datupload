import "server-only";
import { createHash } from "node:crypto";
import { connectDb } from "@/lib/db";
import { env } from "@/lib/env";
import { ApiError, errors } from "@/lib/errors";
import { deleteChannelMessages } from "@/lib/telegram/delete";
import { sendDocumentPart } from "@/lib/telegram/upload";
import { assertExtensionAllowed, normalizeFolder, sanitizeFilename } from "@/lib/validation/files";
import { resolveContentType, SNIFF_BYTES } from "@/lib/validation/sniff";
import { FileModel, type FilePart, type FileRecord } from "@/models/File";

export interface IngestInput {
  stream: ReadableStream<Uint8Array>;
  filename: string;
  /** Client-declared MIME type. Only used when it agrees with the file's signature. */
  declaredType?: string | null;
  folder?: string | null;
  public?: boolean;
}

/**
 * Re-chunks a byte stream into buffers of exactly `size` bytes (the last may be shorter).
 * Throws FILE_TOO_LARGE as soon as more than `maxTotal` bytes have been read.
 */
export async function* chunkStream(
  stream: ReadableStream<Uint8Array>,
  size: number,
  maxTotal: number,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(size);
  let filled = 0;
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxTotal) throw errors.tooLarge(maxTotal);

      let offset = 0;
      while (offset < value.byteLength) {
        const n = Math.min(size - filled, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + n), filled);
        filled += n;
        offset += n;
        if (filled === size) {
          yield buffer;
          buffer = new Uint8Array(size);
          filled = 0;
        }
      }
    }
    if (filled > 0) yield buffer.subarray(0, filled);
  } finally {
    reader.releaseLock();
    await stream.cancel().catch(() => {});
  }
}

/**
 * Stores a file: validates it, splits it into parts below Telegram's 20 MB download limit,
 * sends each part to the storage channel, and indexes everything in MongoDB.
 * On any failure, already-sent parts and the pending record are removed.
 */
export async function ingest(input: IngestInput): Promise<FileRecord> {
  const config = env();
  const originalFilename = (input.filename ?? "").slice(0, 1024);
  const filename = sanitizeFilename(input.filename);
  const folder = normalizeFolder(input.folder);
  assertExtensionAllowed(filename);

  const chunks = chunkStream(input.stream, config.limits.chunkSize, config.limits.maxFileSize);
  const first = await chunks.next();
  if (first.done || first.value.byteLength === 0) throw errors.invalid("The file is empty.");

  const type = resolveContentType(first.value.subarray(0, SNIFF_BYTES), filename, input.declaredType);
  if (!type.ok) {
    await chunks.return(undefined);
    throw errors.unsupportedType(type.reason);
  }

  await connectDb();
  const record = await FileModel.create({
    filename,
    originalFilename: originalFilename || filename,
    contentType: type.contentType,
    folder,
    public: input.public ?? false,
    status: "uploading",
    source: "api",
    telegramChannelId: config.telegram.channelId,
  });
  const id = record._id.toString();

  const singlePart = first.value.byteLength < config.limits.chunkSize;
  const parts: FilePart[] = [];
  const hash = createHash("sha256");
  let size = 0;

  try {
    let chunk: IteratorResult<Uint8Array> = first;
    while (!chunk.done) {
      const index = parts.length;
      const partName = singlePart ? filename : `${filename}.part${String(index + 1).padStart(3, "0")}`;
      const caption = `${filename}\n#tgstore ${id} part ${index + 1}`;

      let sent;
      try {
        sent = await sendDocumentPart(chunk.value, partName, caption);
      } catch (error) {
        throw errors.telegramUpload(error);
      }

      const part = { index, size: chunk.value.byteLength, ...sent };
      parts.push(part);
      // Persist each part immediately so the cleanup job can find orphaned messages
      // even if this function is killed mid-upload (e.g. by a platform timeout).
      await FileModel.updateOne({ _id: id }, { $push: { parts: part } });
      hash.update(chunk.value);
      size += chunk.value.byteLength;
      chunk = await chunks.next();
    }

    record.set({
      status: "ready",
      size,
      sha256: hash.digest("hex"),
      parts,
      telegramFileId: parts[0].telegramFileId,
      telegramMessageId: parts[0].telegramMessageId,
    });
    await record.save();
    return record.toObject() as FileRecord;
  } catch (error) {
    await chunks.return(undefined).catch(() => {});
    await rollback(id, parts);
    throw error instanceof ApiError ? error : errors.telegramUpload(error);
  }
}

async function rollback(id: string, parts: FilePart[]) {
  try {
    if (parts.length > 0) await deleteChannelMessages(parts.map((p) => p.telegramMessageId));
  } catch (error) {
    console.error(`[ingest] could not remove parts of failed upload ${id}`, error);
  }
  try {
    await FileModel.deleteOne({ _id: id });
  } catch (error) {
    // The cleanup cron removes stale "uploading" records.
    console.error(`[ingest] could not remove pending record ${id}`, error);
  }
}
