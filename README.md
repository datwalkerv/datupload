# Telegram Storage API

A small object-storage API built with Next.js. It keeps file bytes in a **private Telegram channel** and the file catalog in **MongoDB**. Clients use plain HTTP with an API key.

```text
client ──▶ Next.js API ──▶ Telegram Bot API ──▶ private channel   (file bytes)
               │
               └──▶ MongoDB                                        (catalog / index)
               └──▶ Vercel Blob                                    (temporary staging for uploads > 4 MB)
```

- **Telegram stores the files.** Each file is sent to the channel as one or more *documents*. Documents are never recompressed, so the original bytes always come back.
- **MongoDB is the source of truth for what exists.** The Bot API has no "list files in channel" call, so MongoDB maps `our id → Telegram message ids → Telegram file_ids`.
- **Vercel Blob is used only for staging large uploads.** Vercel functions reject request bodies over 4.5 MB, so bigger files are uploaded to Blob first, moved into Telegram, and then deleted from Blob.

---

## Telegram limits this design is built around

These come from the [Bot API docs](https://core.telegram.org/bots/api), version 10.3:

| Limit | Effect on this API |
|---|---|
| `sendDocument` accepts up to **50 MB** per file. | Files are split into **≤ 19 MB parts**, each stored as its own document. |
| `getFile` lets bots download only files up to **20 MB**. | Parts stay under 19 MB, so every part can be downloaded again. Downloads stream the parts back in order as one response. |
| The `getFile` download URL contains the **bot token**. | The API always proxies downloads and never returns or redirects to a Telegram URL. |
| `file_id`s can be reused indefinitely. | Each part's `file_id` is stored in MongoDB at upload time. |
| `deleteMessage`: "*a message can only be deleted if it was sent less than 48 hours ago*". | Deleting a file older than 48 h always removes it from the index (it's gone from the API). Telegram may refuse to delete the message, though. In that case the response says `"telegramMessagesDeleted": false` and the bytes stay in the channel until you remove them by hand. |
| Bots **cannot read channel history**, and `getUpdates` only keeps updates for **24 h**. | `POST /api/admin/sync` is best effort (see below). Nothing depends on it. |
| Flood limits (HTTP 429 with `retry_after`). | The client waits and retries. Very large files take a while: about 105 parts for 2 GB. |

A [local Bot API server](https://github.com/tdlib/telegram-bot-api) raises the limits to 2000 MB uploads and unlimited downloads. It has to run on its own host, though. Set `TELEGRAM_API_BASE_URL` if you use one.

---

## Setup

### 1. Create the bot

1. Open [@BotFather](https://t.me/BotFather) in Telegram and send `/newbot`.
2. Choose a name and a username. BotFather replies with a token like `123456789:AA...`. This is your `TELEGRAM_BOT_TOKEN`.

### 2. Create a private channel and add the bot

1. In Telegram, go to **New Channel**, give it a name, and choose **Private**.
2. Open the channel, then **Manage Channel → Administrators → Add Admin**, search for your bot's username and add it.

### 3. Give the bot administrator rights

The bot needs these rights:

- **Post Messages**, to upload files.
- **Delete Messages of Others** (`can_delete_messages`), to delete files. This also gives it the best chance of deleting messages older than 48 h.
- **Edit Messages of Others** is optional.

### 4. Find the channel ID

Private channel IDs look like `-100xxxxxxxxxx`. Here's the simplest way to find yours:

```bash
# 1. Post any message in the channel, then:
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates?allowed_updates=%5B%22channel_post%22%5D"
# 2. Find "channel_post": { "chat": { "id": -1001234567890, ... } }
```

You can also forward a channel message to [@userinfobot](https://t.me/userinfobot) or open the channel in Telegram Web, where the URL contains `#-100…`.

Delete that message afterwards if you like.

### 5. Configure `.env`

```bash
cp .env.example .env.local
openssl rand -base64 32   # use as STORAGE_API_KEY
```

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | Bot token from BotFather |
| `TELEGRAM_CHANNEL_ID` | yes | `-100…` id of the private channel |
| `STORAGE_API_KEY` | yes | Key clients send as `Authorization: Bearer …` (≥ 16 chars) |
| `MONGODB_URI` | yes | MongoDB connection string |
| `MONGODB_DB_NAME` | | Database name, `telegram-storage` by default |
| `BLOB_READ_WRITE_TOKEN` | for files > 4 MB | Vercel Blob token (staging only) |
| `CRON_SECRET` | on Vercel | Authenticates the cleanup cron |
| `URL_SIGNING_SECRET` | | Secret for signed URLs (defaults to `STORAGE_API_KEY`) |
| `MAX_FILE_SIZE_MB` | | Maximum file size, `2000` by default |
| `PUBLIC_CACHE_MAX_AGE` | | Seconds public files are cached by browsers and the CDN, `86400` by default |
| `CHUNK_SIZE_MB` | | Part size, `19` by default (capped at 19) |
| `DIRECT_UPLOAD_MAX_MB` | | Maximum size for `POST /api/files`, `4` by default |
| `RATE_LIMIT_UPLOADS_PER_MIN` / `RATE_LIMIT_REQUESTS_PER_MIN` | | Per-IP limits, `20` and `300` by default |
| `ALLOWED_EXTENSIONS` / `BLOCKED_EXTENSIONS` | | Comma-separated, e.g. `exe,bat` |

None of these are ever sent to the browser. Every module that reads them imports `server-only`.

### 6. Start MongoDB

```bash
docker run -d --name mongo -p 27017:27017 mongo:8
# MONGODB_URI=mongodb://localhost:27017
```

You can use [MongoDB Atlas](https://www.mongodb.com/atlas) instead. That's the usual choice on Vercel.

### 7. (For files over 4 MB) Create a Vercel Blob store

In the Vercel dashboard, go to your project, then **Storage → Create → Blob**. Choose **Private** access and include the **Development** environment. Then run:

```bash
vercel link && vercel env pull .env.local
```

Without a Blob store, the API still works for files up to 4 MB.

### 8. Run it

```bash
npm install
npm run dev          # http://localhost:3000
curl http://localhost:3000/api/health
# {"status":"ok","database":"connected","telegram":"connected"}
```

---

## Using the API

Every endpoint except `/api/health` and `/api/public/…` requires `Authorization: Bearer $STORAGE_API_KEY`.

```bash
export STORAGE_URL=http://localhost:3000
export STORAGE_API_KEY=your-key
```

### Upload a file (up to 4 MB)

```bash
curl -X POST $STORAGE_URL/api/files \
  -H "Authorization: Bearer $STORAGE_API_KEY" \
  -F "file=@./image.png" \
  -F "folder=projects"          # optional; also: filename, contentType, public=true
```

```json
{
  "id": "6ac54514d5c9d23f0f6b63b7",
  "filename": "image.png",
  "contentType": "image/png",
  "size": 182736,
  "folder": "projects",
  "public": false,
  "publicUrl": null,
  "sha256": "a39e5b04…",
  "parts": 1,
  "telegramFileId": "BQACAgQAAx…",
  "createdAt": "2026-10-06T18:00:00.000Z"
}
```

The content type comes from the file's magic bytes, not from what the client says. If the declared type clearly contradicts the content, the upload is rejected with a 400.

### Upload a large file (staged through Vercel Blob)

The easiest way is the bundled script, which picks the right flow on its own:

```bash
node scripts/upload.mjs ./video.mp4 projects
```

Here is the same flow by hand. The bytes go straight to Blob and never pass through a function.

```js
import { put } from "@vercel/blob/client";

const headers = { authorization: `Bearer ${key}`, "content-type": "application/json" };

// 1. Get a one-time upload token (valid for 15 minutes, limited to this size).
const staged = await fetch(`${url}/api/files/uploads`, {
  method: "POST", headers,
  body: JSON.stringify({ filename: "video.mp4", size: file.size, folder: "projects" }),
}).then((r) => r.json());   // { pathname, clientToken, expiresAt }

// 2. Upload to Blob.
await put(staged.pathname, file, { access: "private", token: staged.clientToken, multipart: true });

// 3. Move it into Telegram. The blob is deleted afterwards, whatever the outcome.
const stored = await fetch(`${url}/api/files/complete`, {
  method: "POST", headers,
  body: JSON.stringify({ pathname: staged.pathname, filename: "video.mp4", folder: "projects" }),
}).then((r) => r.json());
```

### Download a file

```bash
curl -H "Authorization: Bearer $STORAGE_API_KEY" \
  $STORAGE_URL/api/files/6ac54514d5c9d23f0f6b63b7 -o image.png

# View in the browser instead of downloading (images, video, audio, PDF, plain text only):
curl -H "Authorization: Bearer $STORAGE_API_KEY" \
  "$STORAGE_URL/api/files/6ac54514d5c9d23f0f6b63b7?download=false"

# Byte ranges work too (for video seeking and resumable downloads):
curl -H "Authorization: Bearer $STORAGE_API_KEY" -r 0-1023 \
  $STORAGE_URL/api/files/6ac54514d5c9d23f0f6b63b7
```

The response is streamed part by part and never fully buffered. It sets `Content-Type`, `Content-Length`, `Content-Disposition`, `ETag` (sha256), `Accept-Ranges` and `X-Content-Type-Options: nosniff`. `HEAD` returns only the headers.

### Get a shareable URL

```bash
curl -H "Authorization: Bearer $STORAGE_API_KEY" \
  "$STORAGE_URL/api/files/6ac54514d5c9d23f0f6b63b7/url?expiresIn=3600&download=false"
```

```json
{
  "url": "https://storage.example.com/api/files/6ac5…?download=false&expires=1791320000&signature=…",
  "expiresAt": "2026-10-06T19:00:00.000Z"
}
```

The URL points to **this API**, not to Telegram. It works without an `Authorization` header, for example in an `<img src>`, until it expires. `expiresIn` can be anywhere from 60 s to 7 days and defaults to 1 h.

### Show images on a website (public files)

Upload with `public=true`, or publish an existing file with `PATCH`:

```bash
curl -X POST $STORAGE_URL/api/files \
  -H "Authorization: Bearer $STORAGE_API_KEY" \
  -F "file=@./photo.jpg" -F "public=true"
# → { ..., "public": true, "publicUrl": "https://storage.example.com/api/public/6ac5…/photo.jpg" }

curl -X PATCH $STORAGE_URL/api/files/6ac5… \
  -H "Authorization: Bearer $STORAGE_API_KEY" -H "content-type: application/json" \
  -d '{"public": true}'      # or false to make it private again
```

For the staged flow, pass `"public": true` in the `/api/files/complete` body.

`publicUrl` is permanent and needs no key or signature, so you can store it and use it directly:

```html
<img src="https://storage.example.com/api/public/6ac5…/photo.jpg" alt="" />
```

Public files work like this:

- **Caching.** They are served with `Cache-Control: public, max-age=86400, s-maxage=86400` (set by `PUBLIC_CACHE_MAX_AGE`) plus an `ETag`. Vercel's CDN caches them, so Telegram is only contacted on a cache miss. Very large files may exceed the CDN's cacheable size; those are still served, just not cached.
- **Embedding anywhere.** They send `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`, so they work on any site, in `<canvas>` and with `fetch`.
- **Inline display.** Images (except SVG), video, audio, PDF and plain text display inline. Everything else downloads as an attachment, so a public HTML file can't run scripts on your domain.
- **Unknown or private ids return `404`.** The response is the same either way, so you can't tell whether a file exists. The filename at the end of the URL is only cosmetic.
- **Unpublishing is delayed by caching.** Making a file private or deleting it takes effect at once in the API, but browsers and the CDN may keep serving cached copies for up to `PUBLIC_CACHE_MAX_AGE` seconds. Lower it if you need faster takedowns. Anything that should never be public belongs in private files with signed URLs.
- **Next.js `<Image>`** needs your storage domain in `images.remotePatterns`.

### List files

```bash
curl -H "Authorization: Bearer $STORAGE_API_KEY" \
  "$STORAGE_URL/api/files?page=1&limit=50&folder=projects&search=image"
# add &public=true or &public=false to filter by visibility
```

```json
{
  "files": [
    { "id": "6ac5…", "filename": "image.png", "contentType": "image/png", "size": 182736, "folder": "projects", "public": false, "publicUrl": null, "createdAt": "…" }
  ],
  "pagination": { "page": 1, "limit": 50, "total": 124 }
}
```

Files are sorted newest first. `limit` can be at most 100. `search` is a case-insensitive substring match on the filename.

### Delete a file

```bash
curl -X DELETE -H "Authorization: Bearer $STORAGE_API_KEY" \
  $STORAGE_URL/api/files/6ac54514d5c9d23f0f6b63b7
```

```json
{ "id": "6ac5…", "deleted": true, "telegramMessagesDeleted": true }
```

Deletion runs in this order:

1. The record is marked `deleting`, which hides it from the API right away.
2. The Telegram messages are deleted. A message that is already gone counts as deleted.
3. The record is removed.

If step 2 or 3 fails, the API returns `503` and the record stays hidden in the `deleting` state. Calling `DELETE` again, or waiting for the cleanup cron, finishes the job. `"telegramMessagesDeleted": false` means Telegram refused to delete the message, usually because it is older than 48 h. See the limits table above.

### Sync existing channel files (best effort)

```bash
curl -X POST -H "Authorization: Bearer $STORAGE_API_KEY" $STORAGE_URL/api/admin/sync
```

```json
{ "imported": 1, "skipped": { "duplicate": 0, "tooLarge": 0, "unsupported": 0 }, "note": "…" }
```

This reads pending `channel_post` updates with `getUpdates`. It can only find documents, videos and audio **posted by people** to the channel **in the last 24 hours** that a previous sync hasn't already consumed. It skips:

- **Files over 20 MB**, because the Bot API can't download them.
- **Photos**, because Telegram recompresses them and the original is gone.

Sync doesn't work while the bot has a webhook set, and it returns `409` in that case. Uploads made through the API are always indexed at upload time and never need syncing.

### Errors

Every error uses the same shape. Internal Telegram and MongoDB details are only written to the server logs.

```json
{ "error": { "code": "FILE_NOT_FOUND", "message": "The requested file does not exist." } }
```

| Status | Codes |
|---|---|
| 400 | `INVALID_REQUEST`, `FILE_REQUIRED`, `UNSUPPORTED_FILE_TYPE` |
| 401 | `UNAUTHORIZED` |
| 404 | `FILE_NOT_FOUND`, `UPLOAD_NOT_FOUND` |
| 409 | `CONFLICT` (sync while a webhook is set) |
| 413 | `FILE_TOO_LARGE` |
| 416 | `RANGE_NOT_SATISFIABLE` |
| 429 | `RATE_LIMITED` (with `Retry-After`) |
| 501 | `STAGING_NOT_CONFIGURED` (no Blob token) |
| 502 | `TELEGRAM_UPLOAD_FAILED`, `TELEGRAM_DOWNLOAD_FAILED` |
| 503 | `STORAGE_UNAVAILABLE` |
| 500 | `INTERNAL_ERROR` |

---

## Deploying to Vercel

1. Import the repo into Vercel and add the environment variables above. Connecting a Blob store adds `BLOB_READ_WRITE_TOKEN` for you. Also set `CRON_SECRET`.
2. `vercel.json` schedules `GET /api/admin/cleanup` once a day; the Hobby plan only allows daily crons. The cleanup does two things:
   - Deletes staged blobs that were left behind.
   - Finishes uploads or deletes that were interrupted, for example by a function timeout.

   On Pro you can make it hourly.
3. **Function duration is the real upper limit on file size.** Every route uses `maxDuration = 300`, the Hobby plan maximum. A file moves to Telegram at roughly the speed of the Bot API (often 5–20 MB/s, slower if Telegram rate-limits you), so a few hundred MB fits comfortably within 300 s. On Pro you can raise `maxDuration` in `app/api/files/complete/route.ts` to 800. Files in the GB range may need a longer-running host. Set `MAX_FILE_SIZE_MB` to match your plan; `500` is a safe value on Hobby.
4. **Rate limiting** is in memory, which means each serverless instance keeps its own counters. That's fine as a basic guard. For a global limit, implement the `RateLimiter` interface in `lib/rate-limit.ts` with Redis (for example `@upstash/ratelimit`) and export that instance as `rateLimiter`.

---

## Project layout

```text
app/
  page.tsx                      landing page
  api/files/route.ts            POST upload (multipart), GET list
  api/files/uploads/route.ts    POST start staged upload (Blob client token)
  api/files/complete/route.ts   POST finish staged upload
  api/files/[id]/route.ts       GET/HEAD download, PATCH visibility, DELETE
  api/files/[id]/url/route.ts   GET signed URL
  api/public/[id]/[[...name]]   GET/HEAD public file (no auth, CDN-cached)
  api/health/route.ts           GET health
  api/admin/sync/route.ts       POST best-effort channel sync
  api/admin/cleanup/route.ts    GET cron cleanup
lib/
  env.ts  errors.ts  auth.ts  http.ts  rate-limit.ts  db.ts  health.ts
  telegram/  client.ts upload.ts download.ts delete.ts
  storage/   ingest.ts stream.ts serve.ts remove.ts blob.ts sync.ts
  validation/ files.ts sniff.ts
models/File.ts
types/file.ts
scripts/upload.mjs              CLI uploader (direct or staged)
tests/                          Vitest; Telegram and Blob are mocked, MongoDB is in-memory
```

## Development

```bash
npm test            # vitest (uses mongodb-memory-server; no real bot needed)
npm run typecheck
npm run lint
npm run build
```
