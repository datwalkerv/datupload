import { connectDb } from "@/lib/db";
import { env } from "@/lib/env";
import { errors } from "@/lib/errors";
import { requestOrigin, route } from "@/lib/http";
import { ingest } from "@/lib/storage/ingest";
import { assertSize, listQuerySchema, normalizeFolder, parseOrThrow, uploadMetadataSchema } from "@/lib/validation/files";
import { FileModel, type FileRecord } from "@/models/File";
import { toFileDTO, toFileListItem, type FileListResponse } from "@/types/file";

export const maxDuration = 300;

/** Room for multipart boundaries and the metadata fields on top of the file itself. */
const MULTIPART_OVERHEAD = 64 * 1024;

/** POST /api/files: direct multipart upload for files up to DIRECT_UPLOAD_MAX_MB. */
export const POST = route({ rateLimit: "upload" }, async (request) => {
  const { directUploadMax, maxFileSize } = env().limits;
  const directLimit = Math.min(directUploadMax, maxFileSize);

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data")) {
    throw errors.invalid("Use multipart/form-data with the file in the 'file' field.");
  }
  const contentLength = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > directLimit + MULTIPART_OVERHEAD) {
    throw tooLargeForDirect(directLimit, maxFileSize);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw errors.invalid("The multipart body could not be parsed.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) throw errors.fileRequired();
  if (file.size > directLimit) throw tooLargeForDirect(directLimit, maxFileSize);
  assertSize(file.size);

  const meta = parseOrThrow(uploadMetadataSchema, {
    filename: form.get("filename") ?? undefined,
    folder: form.get("folder") ?? undefined,
    contentType: form.get("contentType") ?? undefined,
    public: form.get("public") ?? undefined,
  });

  const record = await ingest({
    stream: file.stream(),
    filename: meta.filename ?? file.name,
    declaredType: meta.contentType ?? file.type,
    folder: meta.folder,
    public: meta.public,
  });
  return Response.json(toFileDTO(record, requestOrigin(request)), { status: 201 });
});

function tooLargeForDirect(directLimit: number, maxFileSize: number) {
  const error = errors.tooLarge(directLimit);
  if (maxFileSize > directLimit) {
    error.message += " Use the staged upload flow (POST /api/files/uploads) for larger files.";
  }
  return error;
}

/** GET /api/files?page&limit&folder&search: newest first. */
export const GET = route({}, async (request) => {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const query = parseOrThrow(listQuerySchema, params);

  const filter: Record<string, unknown> = { status: "ready" };
  const folder = normalizeFolder(query.folder);
  if (folder) filter.folder = folder;
  if (query.public) filter.public = query.public === "true";
  if (query.search) filter.filename = { $regex: escapeRegex(query.search), $options: "i" };

  await connectDb();
  const [files, total] = await Promise.all([
    FileModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit)
      .lean<FileRecord[]>(),
    FileModel.countDocuments(filter),
  ]);

  const body: FileListResponse = {
    files: files.map((f) => toFileListItem(f, requestOrigin(request))),
    pagination: { page: query.page, limit: query.limit, total },
  };
  return Response.json(body);
});

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
