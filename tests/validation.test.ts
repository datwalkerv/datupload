import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/errors";
import { assertExtensionAllowed, assertSize, normalizeFolder, sanitizeFilename } from "@/lib/validation/files";
import { isInlineSafe, resolveContentType, sniffMime } from "@/lib/validation/sniff";
import { setEnv } from "./helpers/setup";
import { PNG_HEADER } from "./helpers/request";

const PDF = new TextEncoder().encode("%PDF-1.7\n...");
const TEXT = new TextEncoder().encode("hello world");

describe("sanitizeFilename", () => {
  it("strips directories, control characters and leading dots", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\photo.jpg")).toBe("photo.jpg");
    expect(sanitizeFilename("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(sanitizeFilename(".env")).toBe("env");
    expect(sanitizeFilename('we"ird<name>.png')).toBe("weirdname.png");
  });

  it("falls back when nothing is left", () => {
    expect(sanitizeFilename("")).toBe("file");
    expect(sanitizeFilename("///")).toBe("file");
    expect(sanitizeFilename(null, "upload")).toBe("upload");
  });

  it("keeps unicode and limits length to 255 bytes, preserving the extension", () => {
    expect(sanitizeFilename("résumé 📄.pdf")).toBe("résumé 📄.pdf");
    const long = sanitizeFilename("é".repeat(300) + ".pdf");
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(255);
    expect(long.endsWith(".pdf")).toBe(true);
  });
});

describe("normalizeFolder", () => {
  it("normalises slashes", () => {
    expect(normalizeFolder("/projects//2026/")).toBe("projects/2026");
    expect(normalizeFolder("")).toBeUndefined();
    expect(normalizeFolder(undefined)).toBeUndefined();
  });

  it("rejects traversal and odd characters", () => {
    expect(() => normalizeFolder("a/../b")).toThrow(ApiError);
    expect(() => normalizeFolder("a/<script>")).toThrow(ApiError);
  });
});

describe("content type detection", () => {
  it("detects common signatures", () => {
    expect(sniffMime(PNG_HEADER)).toBe("image/png");
    expect(sniffMime(PDF)).toBe("application/pdf");
    expect(sniffMime(TEXT)).toBeNull();
  });

  it("prefers the detected type over the client's claim", () => {
    expect(resolveContentType(PNG_HEADER, "image.png", "application/octet-stream")).toEqual({
      ok: true,
      contentType: "image/png",
    });
    expect(resolveContentType(PNG_HEADER, "no-extension", undefined)).toEqual({ ok: true, contentType: "image/png" });
  });

  it("rejects a declared type that contradicts the content", () => {
    const result = resolveContentType(PDF, "image.png", "image/png");
    expect(result.ok).toBe(false);
  });

  it("does not trust a media type without a matching signature", () => {
    expect(resolveContentType(TEXT, "fake.png", "image/png")).toEqual({
      ok: true,
      contentType: "application/octet-stream",
    });
  });

  it("uses the extension for signature-less text formats", () => {
    expect(resolveContentType(TEXT, "notes.txt", undefined)).toEqual({ ok: true, contentType: "text/plain" });
    expect(resolveContentType(TEXT, "data.json", "text/plain")).toEqual({ ok: true, contentType: "application/json" });
  });

  it("refines zip containers by extension", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    expect(resolveContentType(zip, "report.docx", undefined)).toEqual({
      ok: true,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  });

  it("only serves passive types inline", () => {
    expect(isInlineSafe("image/png")).toBe(true);
    expect(isInlineSafe("video/mp4")).toBe(true);
    expect(isInlineSafe("image/svg+xml")).toBe(false);
    expect(isInlineSafe("text/html")).toBe(false);
  });
});

describe("limits", () => {
  it("enforces the configured maximum size", () => {
    setEnv({ MAX_FILE_SIZE_MB: "1" });
    expect(() => assertSize(1024 * 1024)).not.toThrow();
    try {
      assertSize(1024 * 1024 + 1);
      expect.unreachable();
    } catch (error) {
      expect((error as ApiError).status).toBe(413);
      expect((error as ApiError).code).toBe("FILE_TOO_LARGE");
    }
  });

  it("applies allow and block lists", () => {
    setEnv({ BLOCKED_EXTENSIONS: "exe, .bat" });
    expect(() => assertExtensionAllowed("setup.exe")).toThrow(ApiError);
    expect(() => assertExtensionAllowed("run.BAT")).toThrow(ApiError);
    expect(() => assertExtensionAllowed("photo.png")).not.toThrow();

    setEnv({ BLOCKED_EXTENSIONS: undefined, ALLOWED_EXTENSIONS: "png,jpg" });
    expect(() => assertExtensionAllowed("photo.png")).not.toThrow();
    expect(() => assertExtensionAllowed("doc.pdf")).toThrow(ApiError);
    expect(() => assertExtensionAllowed("noext")).toThrow(ApiError);
  });
});
