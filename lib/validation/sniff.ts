/** Bytes needed to recognise every signature below. */
export const SNIFF_BYTES = 64;

type Signature = { mime: string; offset?: number; bytes: (number | null)[] };

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

// `null` matches any byte.
const SIGNATURES: Signature[] = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: ascii("GIF8") },
  { mime: "image/webp", bytes: [...ascii("RIFF"), null, null, null, null, ...ascii("WEBP")] },
  { mime: "image/bmp", bytes: ascii("BM") },
  { mime: "image/tiff", bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mime: "image/tiff", bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { mime: "image/x-icon", bytes: [0x00, 0x00, 0x01, 0x00] },
  { mime: "image/avif", offset: 4, bytes: ascii("ftypavif") },
  { mime: "image/heic", offset: 4, bytes: ascii("ftypheic") },
  { mime: "video/quicktime", offset: 4, bytes: ascii("ftypqt") },
  { mime: "video/mp4", offset: 4, bytes: ascii("ftyp") },
  { mime: "video/webm", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: "video/x-msvideo", bytes: [...ascii("RIFF"), null, null, null, null, ...ascii("AVI ")] },
  { mime: "audio/wav", bytes: [...ascii("RIFF"), null, null, null, null, ...ascii("WAVE")] },
  { mime: "audio/mpeg", bytes: ascii("ID3") },
  { mime: "audio/mpeg", bytes: [0xff, 0xfb] },
  { mime: "audio/mpeg", bytes: [0xff, 0xf3] },
  { mime: "audio/mpeg", bytes: [0xff, 0xf2] },
  { mime: "audio/ogg", bytes: ascii("OggS") },
  { mime: "audio/flac", bytes: ascii("fLaC") },
  { mime: "application/pdf", bytes: ascii("%PDF-") },
  { mime: "application/zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: "application/zip", bytes: [0x50, 0x4b, 0x05, 0x06] },
  { mime: "application/gzip", bytes: [0x1f, 0x8b] },
  { mime: "application/x-7z-compressed", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { mime: "application/vnd.rar", bytes: ascii("Rar!\x1a\x07") },
  { mime: "application/x-bzip2", bytes: ascii("BZh") },
  { mime: "application/wasm", bytes: [0x00, 0x61, 0x73, 0x6d] },
  { mime: "application/x-sqlite3", bytes: ascii("SQLite format 3\0") },
  { mime: "font/woff", bytes: ascii("wOFF") },
  { mime: "font/woff2", bytes: ascii("wOF2") },
];

/** Detects a MIME type from the file's leading bytes, or returns null if unknown. */
export function sniffMime(head: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (head.length < offset + sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => b === null || head[offset + i] === b)) return sig.mime;
  }
  return null;
}

const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  bz2: "application/x-bzip2",
  wasm: "application/wasm",
  sqlite: "application/x-sqlite3",
  db: "application/x-sqlite3",
  woff: "font/woff",
  woff2: "font/woff2",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip",
  jar: "application/java-archive",
  apk: "application/vnd.android.package-archive",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
};

/** Detected types that legitimately cover several declared/extension types. */
const COMPATIBLE: Record<string, string[]> = {
  "application/zip": [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "application/epub+zip",
    "application/java-archive",
    "application/vnd.android.package-archive",
    "application/x-zip-compressed",
  ],
  "video/mp4": ["audio/mp4", "video/x-m4v", "video/quicktime", "image/heic", "image/avif"],
  "video/quicktime": ["video/mp4"],
  "video/webm": ["video/x-matroska", "audio/webm"],
  "audio/ogg": ["video/ogg", "application/ogg"],
  "audio/wav": ["audio/x-wav", "audio/wave"],
  "image/x-icon": ["image/vnd.microsoft.icon"],
  "application/gzip": ["application/x-gzip", "application/x-tar"],
};

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export function mimeFromExtension(filename: string): string | null {
  return EXTENSION_MIME[extensionOf(filename)] ?? null;
}

function normalizeMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const base = mime.split(";")[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(base) ? base : null;
}

function compatible(detected: string, other: string): boolean {
  return detected === other || (COMPATIBLE[detected]?.includes(other) ?? false);
}

/** Types that are generic enough that they never "contradict" a detected type. */
const GENERIC = new Set(["application/octet-stream", "binary/octet-stream", "application/unknown"]);

export type ContentTypeResult =
  | { ok: true; contentType: string }
  | { ok: false; reason: string };

/**
 * Decides the content type to store. The detected signature wins over anything the
 * client says. A declared type that clearly contradicts the signature is rejected.
 */
export function resolveContentType(
  head: Uint8Array,
  filename: string,
  declared: string | null | undefined,
): ContentTypeResult {
  const detected = sniffMime(head);
  const claimed = normalizeMime(declared);
  const fromExtension = mimeFromExtension(filename);

  if (detected) {
    if (claimed && !GENERIC.has(claimed) && !compatible(detected, claimed)) {
      return { ok: false, reason: `The file content (${detected}) does not match the declared type (${claimed}).` };
    }
    // Prefer the more specific extension type when it is a known variant of the detected one
    // (e.g. a .docx is detected as zip).
    if (fromExtension && compatible(detected, fromExtension)) return { ok: true, contentType: fromExtension };
    return { ok: true, contentType: detected };
  }

  // No signature: text formats or unknown binaries. A binary media type we can recognise
  // but didn't detect is not what it claims to be, so fall back to octet-stream.
  const candidate = fromExtension ?? claimed;
  if (!candidate || hasKnownSignature(candidate)) {
    return { ok: true, contentType: "application/octet-stream" };
  }
  return { ok: true, contentType: candidate };
}

const SIGNATURE_MIMES = new Set(
  SIGNATURES.flatMap((s) => [s.mime, ...(COMPATIBLE[s.mime] ?? [])]).filter(
    // These container formats also come in signature-less variants we don't detect.
    (m) => !["application/x-tar", "video/x-matroska"].includes(m),
  ),
);

function hasKnownSignature(mime: string): boolean {
  return SIGNATURE_MIMES.has(mime);
}

/** Types that are safe to render inline on our origin (no script execution). */
export function isInlineSafe(contentType: string): boolean {
  if (contentType === "image/svg+xml") return false;
  return (
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("audio/") ||
    contentType === "application/pdf" ||
    contentType === "text/plain"
  );
}
