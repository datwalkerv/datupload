import "server-only";
import { env } from "@/lib/env";

/** An error reported by the Bot API, or a failure to reach it. Never contains the bot token. */
export class TelegramError extends Error {
  constructor(
    public readonly method: string,
    public readonly errorCode: number,
    public readonly description: string,
    public readonly retryAfter?: number,
  ) {
    super(`Telegram ${method} failed (${errorCode}): ${description}`);
    this.name = "TelegramError";
  }
}

type ApiResponse<T> =
  | { ok: true; result: T }
  | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } };

const MAX_ATTEMPTS = 4;
/** Don't hold a request open waiting on a long flood-wait; surface it instead. */
const MAX_RETRY_AFTER_SECONDS = 30;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function apiUrl(method: string): string {
  const { apiBaseUrl, token } = env().telegram;
  return `${apiBaseUrl}/bot${token}/${method}`;
}

export function fileUrl(filePath: string): string {
  const { apiBaseUrl, token } = env().telegram;
  return `${apiBaseUrl}/file/bot${token}/${filePath}`;
}

/**
 * Calls a Bot API method. JSON params are sent as JSON; FormData is sent as multipart.
 * `body` may be a factory so a multipart body can be rebuilt for each retry.
 * Retries flood-wait (429) responses and transient network/5xx failures.
 */
export async function callApi<T>(
  method: string,
  body?: Record<string, unknown> | (() => FormData),
  { timeoutMs = 30_000 }: { timeoutMs?: number } = {},
): Promise<T> {
  let lastError: TelegramError | undefined;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(apiUrl(method), {
        method: "POST",
        ...(typeof body === "function"
          ? { body: body() }
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) }),
        signal: AbortSignal.timeout(timeoutMs),
        cache: "no-store",
      });
    } catch (error) {
      lastError = new TelegramError(method, 0, error instanceof Error ? error.name : "network error");
      if (attempt < MAX_ATTEMPTS) {
        await sleep(500 * attempt);
        continue;
      }
      throw lastError;
    }

    let data: ApiResponse<T>;
    try {
      data = (await response.json()) as ApiResponse<T>;
    } catch {
      data = { ok: false, error_code: response.status, description: response.statusText || "invalid response" };
    }

    if (data.ok) return data.result;

    const retryAfter = data.parameters?.retry_after;
    lastError = new TelegramError(method, data.error_code, data.description, retryAfter);

    if (attempt === MAX_ATTEMPTS) break;
    if (data.error_code === 429 && retryAfter !== undefined && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
      await sleep(retryAfter * 1000);
      continue;
    }
    if (data.error_code >= 500) {
      await sleep(500 * attempt);
      continue;
    }
    break;
  }

  throw lastError!;
}

// --- Bot API types (only the fields we use) --------------------------------

export interface TgDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: string; title?: string; username?: string };
  caption?: string;
  document?: TgDocument;
  video?: TgDocument & { width: number; height: number; duration: number };
  audio?: TgDocument & { duration: number };
  photo?: (TgDocument & { width: number; height: number })[];
}

export interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

export interface TgUpdate {
  update_id: number;
  channel_post?: TgMessage;
}

export const getMe = () => callApi<{ id: number; is_bot: boolean; username: string }>("getMe");

export const getChat = (chatId: string) =>
  callApi<{ id: number; type: string; title?: string }>("getChat", { chat_id: chatId });
