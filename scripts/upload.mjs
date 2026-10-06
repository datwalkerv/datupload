#!/usr/bin/env node
// Uploads a file of any size to the storage API.
// Files up to 4 MB go straight to POST /api/files; larger files use the staged flow.
//
//   STORAGE_URL=https://storage.example.com STORAGE_API_KEY=... node scripts/upload.mjs ./video.mp4 [folder]

import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import { put } from "@vercel/blob/client";

const [path, folder] = process.argv.slice(2);
const { STORAGE_URL, STORAGE_API_KEY } = process.env;
if (!path || !STORAGE_URL || !STORAGE_API_KEY) {
  console.error("Usage: STORAGE_URL=... STORAGE_API_KEY=... node scripts/upload.mjs <file> [folder]");
  process.exit(1);
}

const DIRECT_LIMIT = 4 * 1024 * 1024;
const auth = { authorization: `Bearer ${STORAGE_API_KEY}` };
const file = await openAsBlob(path);
const filename = basename(path);

async function call(route, init) {
  const res = await fetch(new URL(route, STORAGE_URL), init);
  const body = await res.json();
  if (!res.ok) throw new Error(`${route}: ${res.status} ${body.error?.code}: ${body.error?.message}`);
  return body;
}

let result;
if (file.size <= DIRECT_LIMIT) {
  const form = new FormData();
  form.set("file", file, filename);
  if (folder) form.set("folder", folder);
  result = await call("/api/files", { method: "POST", headers: auth, body: form });
} else {
  // 1. Ask the API for a one-time Blob upload token.
  const staged = await call("/api/files/uploads", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ filename, size: file.size, folder }),
  });
  // 2. Upload the bytes directly to Vercel Blob (never through a function).
  await put(staged.pathname, file, {
    access: "private",
    token: staged.clientToken,
    multipart: true,
    onUploadProgress: ({ percentage }) => process.stderr.write(`\rstaging ${percentage.toFixed(0)}%`),
  });
  process.stderr.write("\nmoving to Telegram...\n");
  // 3. Move it into Telegram. The staged blob is deleted afterwards.
  result = await call("/api/files/complete", {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ pathname: staged.pathname, filename, folder }),
  });
}

console.log(JSON.stringify(result, null, 2));
