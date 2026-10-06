import { isValidObjectId } from "mongoose";
import { z } from "zod";
import { env } from "@/lib/env";
import { errors } from "@/lib/errors";
import { extensionOf } from "@/lib/validation/sniff";

const MAX_FILENAME_BYTES = 255;

/**
 * Reduces a client-supplied name to a safe display filename: no directories, control
 * characters or reserved punctuation, Unicode-normalised, and at most 255 UTF-8 bytes.
 */
export function sanitizeFilename(input: string | null | undefined, fallback = "file"): string {
  let name = (input ?? "").normalize("NFC");
  name = name.split(/[\\/]/).pop() ?? "";
  // Control characters, and characters that are unsafe in headers or file systems.
  name = name.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "").replace(/\s+/g, " ").trim();
  name = name.replace(/^\.+/, "");
  if (!name) return fallback;

  if (Buffer.byteLength(name) > MAX_FILENAME_BYTES) {
    const ext = extensionOf(name);
    const suffix = ext && ext.length <= 16 ? `.${ext}` : "";
    let base = name.slice(0, name.length - suffix.length);
    while (Buffer.byteLength(base + suffix) > MAX_FILENAME_BYTES) base = [...base].slice(0, -1).join("");
    name = base + suffix;
  }
  return name;
}

/** Normalises "/a//b/" to "a/b". Segments may contain letters, digits, space, `._-`. */
export function normalizeFolder(input: string | null | undefined): string | undefined {
  if (input == null) return undefined;
  const segments = input
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;
  for (const s of segments) {
    if (s === "." || s === ".." || !/^[\p{L}\p{N} ._-]{1,64}$/u.test(s)) {
      throw errors.invalid("Invalid folder name. Use letters, numbers, spaces, '.', '_', '-' and '/'.");
    }
  }
  const folder = segments.join("/");
  if (folder.length > 255) throw errors.invalid("Folder path is too long.");
  return folder;
}

export function assertExtensionAllowed(filename: string): void {
  const { allowed, blocked } = env().extensions;
  const ext = extensionOf(filename);
  if (allowed.length > 0 && !allowed.includes(ext)) {
    throw errors.unsupportedType(`Files with the extension '.${ext || "(none)"}' are not allowed.`);
  }
  if (blocked.includes(ext)) {
    throw errors.unsupportedType(`Files with the extension '.${ext}' are not allowed.`);
  }
}

export function assertSize(size: number): void {
  const max = env().limits.maxFileSize;
  if (size > max) throw errors.tooLarge(max);
}

export function parseFileId(id: string): string {
  if (!isValidObjectId(id) || !/^[a-f0-9]{24}$/i.test(id)) throw errors.notFound();
  return id;
}

// --- Request schemas ------------------------------------------------------

const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

/** Multipart fields arrive as strings: accept "true"/"false" (and 1/0). */
const formBoolean = z
  .enum(["true", "false", "1", "0"])
  .optional()
  .transform((v) => v === "true" || v === "1");

export const uploadMetadataSchema = z.object({
  filename: optionalText(1024),
  folder: optionalText(512),
  contentType: optionalText(255),
  public: formBoolean,
});

export const stagedUploadSchema = z.object({
  filename: z.string().trim().min(1).max(1024),
  size: z.number().int().positive(),
  folder: optionalText(512),
  contentType: optionalText(255),
  public: z.boolean().default(false),
});

export const completeUploadSchema = z.object({
  pathname: z.string().min(1).max(2048),
  filename: optionalText(1024),
  folder: optionalText(512),
  contentType: optionalText(255),
  public: z.boolean().default(false),
});

export const updateFileSchema = z.object({
  public: z.boolean(),
});

export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  folder: optionalText(512),
  search: optionalText(200),
  public: z.enum(["true", "false"]).optional(),
});

export const urlQuerySchema = z.object({
  expiresIn: z.coerce.number().int().min(60).max(7 * 24 * 3600).default(3600),
  download: z.enum(["true", "false"]).default("true"),
});

/** Parses with a zod schema, converting failures into a 400 with a readable message. */
export function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue.path.length ? `'${issue.path.join(".")}': ` : "";
    throw errors.invalid(`${where}${issue.message}`);
  }
  return result.data;
}
