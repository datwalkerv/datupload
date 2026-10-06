import { API_KEY } from "./setup";

export const BASE = "https://storage.test";

export function authHeaders(key = API_KEY): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

export function ctx<T extends Record<string, string>>(params: T) {
  return { params: Promise.resolve(params) };
}

export function uploadRequest(
  file: Blob | null,
  { filename = "image.png", fields = {}, headers = authHeaders() }: {
    filename?: string;
    fields?: Record<string, string>;
    headers?: Record<string, string>;
  } = {},
) {
  const form = new FormData();
  if (file) form.set("file", file, filename);
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request(`${BASE}/api/files`, { method: "POST", headers, body: form });
}

export const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A buffer of `size` bytes starting with a PNG signature and a predictable pattern. */
export function pngBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = i % 251;
  bytes.set(PNG_HEADER.subarray(0, Math.min(size, PNG_HEADER.length)));
  return bytes;
}

export function streamOf(bytes: Uint8Array, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

export async function readAll(response: Response): Promise<Uint8Array> {
  return new Uint8Array(await response.arrayBuffer());
}
