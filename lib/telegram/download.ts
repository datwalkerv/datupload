import "server-only";
import { callApi, fileUrl, TelegramError, type TgFile } from "@/lib/telegram/client";

/** Resolves a stored `file_id` to a temporary download path (valid for at least 1 hour). */
export async function getFilePath(fileId: string): Promise<string> {
  const file = await callApi<TgFile>("getFile", { file_id: fileId });
  if (!file.file_path) throw new TelegramError("getFile", 0, "no file_path in response");
  return file.file_path;
}

/**
 * Opens a streaming download of a Telegram file. The URL contains the bot token,
 * so it is only ever fetched server-side and never returned to clients.
 * `range` is an inclusive byte range within this file.
 */
export async function openFileStream(
  filePath: string,
  range?: { start: number; end: number },
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const response = await fetch(fileUrl(filePath), {
    headers: range ? { range: `bytes=${range.start}-${range.end}` } : undefined,
    signal,
    cache: "no-store",
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new TelegramError("file download", response.status, response.statusText || "download failed");
  }
  // If the server ignored the Range header we have to skip the leading bytes ourselves.
  if (range && response.status !== 206) {
    return sliceStream(response.body, range.start, range.end - range.start + 1);
  }
  return response.body;
}

/** Skips `skip` bytes, then passes through `length` bytes and cancels the rest. */
export function sliceStream(
  source: ReadableStream<Uint8Array>,
  skip: number,
  length: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let toSkip = skip;
  let remaining = length;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (remaining <= 0) {
          await reader.cancel();
          controller.close();
          return;
        }
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        let chunk = value;
        if (toSkip > 0) {
          if (chunk.byteLength <= toSkip) {
            toSkip -= chunk.byteLength;
            continue;
          }
          chunk = chunk.subarray(toSkip);
          toSkip = 0;
        }
        if (chunk.byteLength > remaining) chunk = chunk.subarray(0, remaining);
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
        return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
