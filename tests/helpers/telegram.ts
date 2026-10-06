import { vi } from "vitest";

interface StoredMessage {
  id: number;
  fileId: string;
  bytes: Uint8Array;
  filename: string;
  caption?: string;
}

/**
 * In-memory stand-in for the Telegram Bot API, installed by stubbing global `fetch`.
 * Tests never touch the network or a real bot.
 */
export function installFakeTelegram() {
  const messages = new Map<number, StoredMessage>();
  const files = new Map<string, StoredMessage>();
  let nextMessageId = 100;

  const state = {
    messages,
    calls: [] as { method: string; body: unknown }[],
    /** Fail every sendDocument call after this many have succeeded. */
    failSendAfter: Infinity,
    failGetFile: false,
    /** Message ids that Telegram refuses to delete (e.g. older than 48 h). */
    undeletable: new Set<number>(),
    webhookUrl: "",
    updates: [] as unknown[],
    chatReachable: true,
  };

  const ok = (result: unknown) => Response.json({ ok: true, result });
  const fail = (code: number, description: string) =>
    Response.json({ ok: false, error_code: code, description }, { status: code });

  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== "https://telegram.test") throw new Error(`Unexpected fetch to ${url.origin}`);

    // File downloads: /file/bot<token>/<path>
    const fileMatch = /^\/file\/bot[^/]+\/(.+)$/.exec(url.pathname);
    if (fileMatch) {
      const stored = files.get(decodeURIComponent(fileMatch[1]).replace(/^documents\//, ""));
      if (!stored) return new Response("Not Found", { status: 404 });
      const range = new Headers(init?.headers).get("range");
      const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
      if (m) {
        const slice = stored.bytes.slice(Number(m[1]), Number(m[2]) + 1);
        return new Response(slice, { status: 206 });
      }
      return new Response(stored.bytes.slice(), { status: 200 });
    }

    const method = url.pathname.split("/").pop()!;
    const body: Record<string, unknown> =
      init?.body instanceof FormData ? Object.fromEntries(init.body) : JSON.parse(String(init?.body ?? "{}"));
    state.calls.push({ method, body });

    switch (method) {
      case "getMe":
        return ok({ id: 1, is_bot: true, username: "test_bot" });
      case "getChat":
        return state.chatReachable ? ok({ id: -1001234567890, type: "channel" }) : fail(400, "Bad Request: chat not found");
      case "sendDocument": {
        const sent = state.calls.filter((c) => c.method === "sendDocument").length;
        if (sent > state.failSendAfter) return fail(400, "Bad Request: upload failed");
        const doc = body.document as File;
        const bytes = new Uint8Array(await doc.arrayBuffer());
        const id = nextMessageId++;
        const fileId = `file-${id}`;
        const stored = { id, fileId, bytes, filename: doc.name, caption: body.caption as string };
        messages.set(id, stored);
        files.set(fileId, stored);
        return ok({
          message_id: id,
          date: Math.floor(Date.now() / 1000),
          chat: { id: -1001234567890, type: "channel" },
          document: { file_id: fileId, file_unique_id: `uniq-${id}`, file_name: doc.name, file_size: bytes.byteLength },
        });
      }
      case "getFile": {
        if (state.failGetFile) return fail(400, "Bad Request: file is too big");
        const stored = files.get(body.file_id as string);
        if (!stored) return fail(400, "Bad Request: invalid file_id");
        return ok({ file_id: stored.fileId, file_unique_id: `uniq-${stored.id}`, file_path: `documents/${stored.fileId}` });
      }
      case "deleteMessages": {
        const ids = body.message_ids as number[];
        if (ids.some((id) => state.undeletable.has(id))) return fail(400, "Bad Request: message can't be deleted");
        for (const id of ids) deleteStored(id);
        return ok(true);
      }
      case "deleteMessage": {
        const id = body.message_id as number;
        if (state.undeletable.has(id)) return fail(400, "Bad Request: message can't be deleted");
        if (!messages.has(id)) return fail(400, "Bad Request: message to delete not found");
        deleteStored(id);
        return ok(true);
      }
      case "getWebhookInfo":
        return ok({ url: state.webhookUrl });
      case "getUpdates": {
        const offset = (body.offset as number | undefined) ?? 0;
        const pending = (state.updates as { update_id: number }[]).filter((u) => u.update_id >= offset);
        state.updates = pending;
        return ok(pending.slice(0, (body.limit as number) ?? 100));
      }
      default:
        return fail(404, `Not Found: method ${method}`);
    }
  };

  function deleteStored(id: number) {
    const stored = messages.get(id);
    if (!stored) return;
    messages.delete(id);
    files.delete(stored.fileId);
  }

  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return Object.assign(state, { fetch: fetchMock });
}

export type FakeTelegram = ReturnType<typeof installFakeTelegram>;
