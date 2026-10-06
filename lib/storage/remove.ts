import "server-only";
import { errors } from "@/lib/errors";
import { deleteChannelMessages } from "@/lib/telegram/delete";
import { FileModel, type FileRecord } from "@/models/File";

export interface RemoveResult {
  /** False when Telegram refused to delete some messages (e.g. older than 48 hours). */
  telegramMessagesDeleted: boolean;
}

/**
 * Deletes a file's Telegram messages and then its index record.
 *
 * The record is expected to be in "deleting" state already, which hides it from the API.
 * If any step fails it stays that way, so calling DELETE again (or the cleanup job)
 * finishes the job. Messages that no longer exist count as deleted.
 */
export async function removeFile(file: Pick<FileRecord, "_id" | "parts">): Promise<RemoveResult> {
  const messageIds = file.parts.map((p) => p.telegramMessageId);

  let telegramMessagesDeleted = true;
  if (messageIds.length > 0) {
    try {
      ({ deleted: telegramMessagesDeleted } = await deleteChannelMessages(messageIds));
    } catch (error) {
      throw errors.unavailable(error);
    }
  }

  if (!telegramMessagesDeleted) {
    console.warn(
      `[delete] file ${file._id} removed from the index, but some Telegram messages could not be deleted`,
    );
  }

  try {
    await FileModel.deleteOne({ _id: file._id });
  } catch (error) {
    throw errors.unavailable(error);
  }
  return { telegramMessagesDeleted };
}
