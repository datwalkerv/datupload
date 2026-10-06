import type { FileRecord } from "@/models/File";

/** Public shape of a stored file. Never includes Telegram channel or credential details. */
export interface FileDTO {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  folder: string | null;
  public: boolean;
  /** Permanent, unauthenticated URL. Only set for public files. */
  publicUrl: string | null;
  sha256: string | null;
  parts: number;
  telegramFileId: string | null;
  createdAt: string;
}

export interface FileListItem {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  folder: string | null;
  public: boolean;
  publicUrl: string | null;
  createdAt: string;
}

export interface FileListResponse {
  files: FileListItem[];
  pagination: { page: number; limit: number; total: number };
}

/** `/api/public/:id/:filename`. The filename is cosmetic, so the URL ends in a real file name. */
export function publicPath(file: Pick<FileRecord, "_id" | "filename">): string {
  return `/api/public/${file._id.toString()}/${encodeURIComponent(file.filename)}`;
}

function publicUrl(file: FileRecord, origin: string): string | null {
  return file.public ? new URL(publicPath(file), origin).toString() : null;
}

export function toFileDTO(file: FileRecord, origin: string): FileDTO {
  return {
    id: file._id.toString(),
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    folder: file.folder ?? null,
    public: file.public ?? false,
    publicUrl: publicUrl(file, origin),
    sha256: file.sha256 ?? null,
    parts: file.parts.length,
    telegramFileId: file.telegramFileId ?? null,
    createdAt: file.createdAt.toISOString(),
  };
}

export function toFileListItem(file: FileRecord, origin: string): FileListItem {
  return {
    id: file._id.toString(),
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    folder: file.folder ?? null,
    public: file.public ?? false,
    publicUrl: publicUrl(file, origin),
    createdAt: file.createdAt.toISOString(),
  };
}
