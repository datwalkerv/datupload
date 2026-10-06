export type ErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_REQUEST"
  | "FILE_REQUIRED"
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_TOO_LARGE"
  | "FILE_NOT_FOUND"
  | "UPLOAD_NOT_FOUND"
  | "RANGE_NOT_SATISFIABLE"
  | "RATE_LIMITED"
  | "CONFLICT"
  | "STAGING_NOT_CONFIGURED"
  | "TELEGRAM_UPLOAD_FAILED"
  | "TELEGRAM_DOWNLOAD_FAILED"
  | "STORAGE_UNAVAILABLE"
  | "INTERNAL_ERROR";

export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
    public readonly headers?: Record<string, string>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ApiError";
  }
}

export const errors = {
  unauthorized: () =>
    new ApiError("UNAUTHORIZED", 401, "A valid API key is required.", {
      "WWW-Authenticate": 'Bearer realm="storage"',
    }),
  invalid: (message = "The request is invalid.") => new ApiError("INVALID_REQUEST", 400, message),
  fileRequired: () => new ApiError("FILE_REQUIRED", 400, "A file is required in the 'file' field."),
  unsupportedType: (message = "This file type is not allowed.") =>
    new ApiError("UNSUPPORTED_FILE_TYPE", 400, message),
  tooLarge: (maxBytes: number) =>
    new ApiError(
      "FILE_TOO_LARGE",
      413,
      `The file exceeds the maximum allowed size of ${formatBytes(maxBytes)}.`,
    ),
  notFound: () => new ApiError("FILE_NOT_FOUND", 404, "The requested file does not exist."),
  rateLimited: (retryAfterSeconds: number) =>
    new ApiError("RATE_LIMITED", 429, "Too many requests. Try again later.", {
      "Retry-After": String(retryAfterSeconds),
    }),
  telegramUpload: (cause?: unknown) =>
    new ApiError("TELEGRAM_UPLOAD_FAILED", 502, "The storage backend rejected the upload.", undefined, {
      cause,
    }),
  telegramDownload: (cause?: unknown) =>
    new ApiError(
      "TELEGRAM_DOWNLOAD_FAILED",
      502,
      "The file could not be retrieved from the storage backend.",
      undefined,
      { cause },
    ),
  unavailable: (cause?: unknown) =>
    new ApiError("STORAGE_UNAVAILABLE", 503, "The storage service is temporarily unavailable.", undefined, {
      cause,
    }),
};

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    if (error.status >= 500) console.error(`[api] ${error.code}`, error.cause ?? error);
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: error.headers },
    );
  }
  console.error("[api] unhandled error", error);
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } },
    { status: 500 },
  );
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[unit]}`;
}
