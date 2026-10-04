import { z } from "zod";

export const FileEntryTypeSchema = z.enum(["file", "directory", "symlink", "other"]);
export type FileEntryType = z.infer<typeof FileEntryTypeSchema>;

export const FileEntrySchema = z.strictObject({
  name: z.string(),
  path: z.string().min(1),
  type: FileEntryTypeSchema,
  size: z.number().int().nonnegative(),
  mode: z.number().int().nonnegative(),
  /** Epoch milliseconds. */
  modifiedAt: z.number().int().nonnegative(),
});

export type FileEntry = z.infer<typeof FileEntrySchema>;

export const FileListResponseSchema = z.strictObject({
  path: z.string().min(1),
  entries: z.array(FileEntrySchema),
});

export type FileListResponse = z.infer<typeof FileListResponseSchema>;

export const FileMetadataSchema = z.strictObject({
  path: z.string().min(1),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
});

export type FileMetadata = z.infer<typeof FileMetadataSchema>;

export const FileContentSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
});

export type FileContent = z.infer<typeof FileContentSchema>;

export const WriteFileRequestSchema = z.strictObject({
  path: z.string().min(1),
  content: z.string(),
});

export type WriteFileRequest = z.infer<typeof WriteFileRequestSchema>;

export const CreateFileRequestSchema = z.strictObject({
  path: z.string().min(1),
  type: z.enum(["file", "directory"]),
});

export type CreateFileRequest = z.infer<typeof CreateFileRequestSchema>;

/**
 * Limits shared by the server and the web UI. Text editing is intentionally
 * bounded; larger payloads go through upload/download (PROJECT.md §42:
 * oversized file requests must be rejected).
 */
export const FILE_LIMITS = {
  maxTextFileBytes: 1024 * 1024,
  maxUploadBytes: 16 * 1024 * 1024,
} as const;
