import "server-only";
import { env } from "@/lib/env";
import { callApi, TelegramError } from "@/lib/telegram/client";

/** deleteMessages accepts at most 100 message ids per call. */
const BATCH_SIZE = 100;

export interface DeleteResult {
  /** True when every message is confirmed gone from the channel. */
  deleted: boolean;
}

/**
 * Deletes messages from the storage channel.
 *
 * Telegram's documented limits: a message can only be deleted if it was sent less than
 * 48 hours ago (bots with `can_delete_messages` in a channel are often allowed to delete
 * older ones, but that isn't guaranteed). A message that no longer exists counts as deleted.
 */
export async function deleteChannelMessages(messageIds: number[]): Promise<DeleteResult> {
  const chatId = env().telegram.channelId;
  let deleted = true;

  for (let i = 0; i < messageIds.length; i += BATCH_SIZE) {
    const batch = messageIds.slice(i, i + BATCH_SIZE);
    try {
      // deleteMessages skips messages that can't be found and returns true.
      await callApi<boolean>("deleteMessages", { chat_id: chatId, message_ids: batch });
    } catch (error) {
      if (!(error instanceof TelegramError) || error.errorCode !== 400) throw error;
      // Fall back to one-by-one so a single undeletable message doesn't hide the rest.
      for (const id of batch) {
        if (!(await deleteOne(chatId, id))) deleted = false;
      }
    }
  }

  return { deleted };
}

async function deleteOne(chatId: string, messageId: number): Promise<boolean> {
  try {
    await callApi<boolean>("deleteMessage", { chat_id: chatId, message_id: messageId });
    return true;
  } catch (error) {
    if (!(error instanceof TelegramError) || error.errorCode !== 400) throw error;
    if (/not found|MESSAGE_ID_INVALID/i.test(error.description)) return true;
    // e.g. "message can't be deleted" (too old, or the bot lacks the delete right).
    console.warn(`[telegram] could not delete message ${messageId}: ${error.description}`);
    return false;
  }
}
