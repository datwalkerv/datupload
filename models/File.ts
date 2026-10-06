import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

const partSchema = new Schema(
  {
    index: { type: Number, required: true },
    size: { type: Number, required: true },
    telegramFileId: { type: String, required: true },
    telegramFileUniqueId: { type: String, required: true },
    telegramMessageId: { type: Number, required: true },
  },
  { _id: false },
);

const fileSchema = new Schema(
  {
    filename: { type: String, required: true },
    originalFilename: { type: String, required: true },
    contentType: { type: String, required: true },
    size: { type: Number, required: true, default: 0 },
    sha256: { type: String },
    folder: { type: String },
    /** Public files are served without auth at /api/public/:id/:filename and may be CDN-cached. */
    public: { type: Boolean, required: true, default: false },

    /**
     * uploading: parts are being sent; not visible through the API.
     * ready:     fully stored and downloadable.
     * deleting:  delete in progress; hidden, and DELETE can be retried to finish it.
     */
    status: { type: String, enum: ["uploading", "ready", "deleting"], required: true, default: "uploading" },
    source: { type: String, enum: ["api", "sync"], required: true, default: "api" },

    telegramChannelId: { type: String, required: true },
    // Mirrors parts[0], so single-part files read like the simple { fileId, messageId } shape.
    telegramFileId: { type: String },
    telegramMessageId: { type: Number },
    parts: { type: [partSchema], default: [] },
  },
  { timestamps: true },
);

fileSchema.index({ status: 1, createdAt: -1 });
fileSchema.index({ folder: 1, status: 1, createdAt: -1 });
fileSchema.index({ public: 1, status: 1, createdAt: -1 });
// Lets sync skip files that are already indexed. Not unique: Telegram may deduplicate
// identical uploads to the same file_unique_id, and both uploads are valid records.
fileSchema.index({ "parts.telegramFileUniqueId": 1 });

export interface FilePart {
  index: number;
  size: number;
  telegramFileId: string;
  telegramFileUniqueId: string;
  telegramMessageId: number;
}

export type FileRecord = Omit<InferSchemaType<typeof fileSchema>, "parts"> & {
  _id: mongoose.Types.ObjectId;
  parts: FilePart[];
  createdAt: Date;
  updatedAt: Date;
};

export const FileModel: Model<FileRecord> =
  (mongoose.models.File as Model<FileRecord> | undefined) ??
  mongoose.model<FileRecord>("File", fileSchema);
