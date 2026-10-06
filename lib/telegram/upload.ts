import "server-only";
import { env } from "@/lib/env";
import { callApi, type TgMessage } from "@/lib/telegram/client";

export interface SentPart {
  telegramFileId: string;
  telegramFileUniqueId: string;
  telegramMessageId: number;
}

/**
 * Sends one part to the storage channel as a document.
 *
 * Documents are stored byte-for-byte: Telegram only recompresses photos and videos sent
 * through sendPhoto/sendVideo. `disable_content_type_detection` additionally stops
 * Telegram from turning a document into a video/audio message, so `getFile` always
 * returns the original bytes.
 */
export async function sendDocumentPart(
  data: Uint8Array,
  filename: string,
  caption: string,
): Promise<SentPart> {
  const channelId = env().telegram.channelId;
  const message = await callApi<TgMessage>(
    "sendDocument",
    () => {
      const form = new FormData();
      form.set("chat_id", channelId);
      form.set("caption", caption);
      form.set("disable_content_type_detection", "true");
      form.set("disable_notification", "true");
      form.set(
        "document",
        new Blob([data as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }),
        filename,
      );
      return form;
    },
    { timeoutMs: 120_000 },
  );

  const doc = message.document ?? message.video ?? message.audio;
  if (!doc) throw new Error("Telegram response did not include a document");

  return {
    telegramFileId: doc.file_id,
    telegramFileUniqueId: doc.file_unique_id,
    telegramMessageId: message.message_id,
  };
}
