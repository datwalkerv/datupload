import "server-only";
import { errors } from "@/lib/errors";
import { getFilePath, openFileStream } from "@/lib/telegram/download";
import type { FilePart } from "@/models/File";

export interface ByteRange {
  start: number;
  /** Inclusive. */
  end: number;
}

/**
 * Parses a single-range `Range: bytes=...` header against a file of `size` bytes.
 * Returns null when the header is absent or unusable (serve the whole file),
 * or "unsatisfiable" for a well-formed range that lies outside the file.
 */
export function parseRange(header: string | null, size: number): ByteRange | null | "unsatisfiable" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;

  let start: number;
  let end: number;
  if (match[1] === "") {
    // Suffix range: the last N bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Maps a byte range over the whole file onto per-part ranges. */
export function planParts(parts: FilePart[], range: ByteRange) {
  const plan: { part: FilePart; start: number; end: number }[] = [];
  let offset = 0;
  for (const part of [...parts].sort((a, b) => a.index - b.index)) {
    const partStart = offset;
    const partEnd = offset + part.size - 1;
    offset += part.size;
    if (partEnd < range.start || partStart > range.end) continue;
    plan.push({
      part,
      start: Math.max(range.start, partStart) - partStart,
      end: Math.min(range.end, partEnd) - partStart,
    });
  }
  return plan;
}

/**
 * Streams the requested byte range of a stored file by fetching each Telegram part in
 * order. Only one part is in flight at a time, so memory use stays small regardless of
 * file size. The first part is opened eagerly so a Telegram failure becomes a clean 502
 * instead of a truncated 200.
 */
export async function openStoredFile(
  parts: FilePart[],
  range: ByteRange,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const plan = planParts(parts, range);

  const open = async (i: number) => {
    const { part, start, end } = plan[i];
    const path = await getFilePath(part.telegramFileId);
    const whole = start === 0 && end === part.size - 1;
    return openFileStream(path, whole ? undefined : { start, end }, signal);
  };

  let index = 0;
  let current: ReadableStreamDefaultReader<Uint8Array> | null;
  try {
    current = plan.length > 0 ? (await open(0)).getReader() : null;
  } catch (error) {
    throw errors.telegramDownload(error);
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (current) {
          const { done, value } = await current.read();
          if (!done) {
            controller.enqueue(value);
            return;
          }
          index++;
          current = index < plan.length ? (await open(index)).getReader() : null;
        }
        controller.close();
      } catch (error) {
        // Headers are already sent, so all we can do is abort the body.
        console.error("[download] stream failed mid-transfer", error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await current?.cancel(reason);
    },
  });
}
