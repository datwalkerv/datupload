import { describe, expect, it, vi } from "vitest";
import { signFileUrl, verifyApiKey, verifySignedUrl } from "@/lib/auth";
import { GET as listFiles } from "@/app/api/files/route";
import { API_KEY } from "./helpers/setup";
import { authHeaders, BASE } from "./helpers/request";

const req = (headers: Record<string, string> = {}) => new Request(`${BASE}/api/files`, { headers });

describe("verifyApiKey", () => {
  it("accepts the configured key", () => {
    expect(verifyApiKey(req(authHeaders()))).toBe(true);
    expect(verifyApiKey(req({ authorization: `bearer ${API_KEY}` }))).toBe(true);
  });

  it("rejects missing, malformed and wrong keys", () => {
    expect(verifyApiKey(req())).toBe(false);
    expect(verifyApiKey(req({ authorization: API_KEY }))).toBe(false);
    expect(verifyApiKey(req({ authorization: `Basic ${API_KEY}` }))).toBe(false);
    expect(verifyApiKey(req(authHeaders("wrong-key")))).toBe(false);
    expect(verifyApiKey(req(authHeaders(API_KEY + "x")))).toBe(false);
    expect(verifyApiKey(req(authHeaders(API_KEY.slice(0, -1))))).toBe(false);
  });
});

describe("protected endpoints", () => {
  it("return 401 with a consistent error body when the key is missing", async () => {
    const res = await listFiles(req(), undefined);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(await res.json()).toEqual({
      error: { code: "UNAUTHORIZED", message: "A valid API key is required." },
    });
  });

  it("return 401 for an invalid key", async () => {
    const res = await listFiles(req(authHeaders("not-the-key")), undefined);
    expect(res.status).toBe(401);
  });
});

describe("signed URLs", () => {
  const id = "65f000000000000000000001";
  const params = (expires: number, signature: string) =>
    new URLSearchParams({ expires: String(expires), signature });

  it("accepts a valid, unexpired signature", () => {
    const expires = Math.floor(Date.now() / 1000) + 60;
    expect(verifySignedUrl(id, params(expires, signFileUrl(id, expires, false)), false)).toBe(true);
  });

  it("rejects expired, tampered or mismatched signatures", () => {
    const expires = Math.floor(Date.now() / 1000) + 60;
    const sig = signFileUrl(id, expires, false);
    expect(verifySignedUrl(id, params(expires + 1, sig), false)).toBe(false); // extended expiry
    expect(verifySignedUrl("65f000000000000000000002", params(expires, sig), false)).toBe(false);
    expect(verifySignedUrl(id, params(expires, sig), true)).toBe(false); // disposition changed
    expect(verifySignedUrl(id, params(expires, sig.slice(0, -2) + "AA"), false)).toBe(false);
    expect(verifySignedUrl(id, new URLSearchParams(), false)).toBe(false);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000);
    expect(verifySignedUrl(id, params(expires, sig), false)).toBe(false);
    vi.useRealTimers();
  });
});
