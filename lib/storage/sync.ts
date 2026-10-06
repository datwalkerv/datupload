import "server-only";
import { connectDb } from "@/lib/db";
import { env, TELEGRAM_MAX_DOWNLOAD_BYTES } from "@/lib/env";
import { ApiError } from "@/lib/errors";
import { callApi, type TgDocument, type TgMessage, type TgUpdate } from "@/lib/telegram/client";
import { sanitizeFilename } from "@/lib/validation/files";
import { mimeFromExtension } from "@/lib/validation/sniff";
import { FileModel } from "@/models/File";

export interface SyncResult {
  imported: number;
  skipped: { duplicate: number; tooLarge: number; unsupported: number };
  note: string;
}

const NOTE =
  "Best-effort: bots cannot read channel history. Only files posted to the channel by other " +
  "users within the last 24 hours (and not yet consumed by a previous sync) can be discovered. " +
  "Files over 20 MB are skipped because the Bot API cannot download them.";

const MAX_BATCHES = 20;

function isOurChannel(message: TgMessage): boolean {
  const configured = env().telegram.channelId;
  return (
    String(message.chat.id) === configured ||
    (message.chat.username !== undefined && `@${message.chat.username}`.toLowerCase() === configured.toLowerCase())
  );
}

function fileOf(message: TgMessage): (TgDocument & { kind: string }) | null {
  if (message.document) return { ...message.document, kind: "document" };
  if (message.video) return { ...message.video, kind: "video" };
  if (message.audio) return { ...message.audio, kind: "audio" };
  // Photos are recompressed by Telegram, so the original is not available.
  return null;
}

/**
 * Imports documents posted to the storage channel into the index, using getUpdates.
 * Uploads made through this API never depend on it: they are indexed at upload time.
 */
export async function syncChannel(): Promise<SyncResult> {
  const webhook = await callApi<{ url: string }>("getWebhookInfo");
  if (webhook.url) {
    throw new ApiError("CONFLICT", 409, "Sync is unavailable while a webhook is configured for this bot.");
  }

  await connectDb();
  const result: SyncResult = { imported: 0, skipped: { duplicate: 0, tooLarge: 0, unsupported: 0 }, note: NOTE };
  let offset: number | undefined;

  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const updates = await callApi<TgUpdate[]>("getUpdates", {
      offset,
      limit: 100,
      timeout: 0,
      allowed_updates: ["channel_post"],
    });
    if (updates.length === 0) break;
    offset = updates[updates.length - 1].update_id + 1;

    for (const update of updates) {
      const message = update.channel_post;
      if (!message || !isOurChannel(message)) continue;
      if (message.caption?.includes("#tgstore")) continue; // already uploaded through this API

      const file = fileOf(message);
      if (!file) {
        result.skipped.unsupported++;
        continue;
      }
      if ((file.file_size ?? 0) > TELEGRAM_MAX_DOWNLOAD_BYTES) {
        result.skipped.tooLarge++;
        continue;
      }
      if (await FileModel.exists({ "parts.telegramFileUniqueId": file.file_unique_id })) {
        result.skipped.duplicate++;
        continue;
      }

      const filename = sanitizeFilename(file.file_name, `${file.kind}-${message.message_id}`);
      const size = file.file_size ?? 0;
      await FileModel.create({
        filename,
        originalFilename: file.file_name ?? filename,
        contentType: file.mime_type ?? mimeFromExtension(filename) ?? "application/octet-stream",
        size,
        status: "ready",
        source: "sync",
        telegramChannelId: env().telegram.channelId,
        telegramFileId: file.file_id,
        telegramMessageId: message.message_id,
        parts: [
          {
            index: 0,
            size,
            telegramFileId: file.file_id,
            telegramFileUniqueId: file.file_unique_id,
            telegramMessageId: message.message_id,
          },
        ],
        createdAt: new Date(message.date * 1000),
      });
      result.imported++;
    }
  }

  // Acknowledge everything we processed so Telegram drops those updates.
  if (offset !== undefined) {
    await callApi("getUpdates", { offset, limit: 1, timeout: 0, allowed_updates: ["channel_post"] });
  }
  return result;
}
