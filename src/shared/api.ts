/** 前后端共享的请求校验 schema 与响应类型。 */
import { z } from 'zod';
import {
  BLOCK_KINDS,
  MATERIAL_STATUSES,
  NOTE_TYPES,
  type AssetMime,
  type BlockKind,
  type MaterialStatus,
  type NoteType,
  type SearchField,
} from './constants.js';

const id = z.uuid();
const optionalText = (max: number) => z.string().max(max).nullable().optional();

export const blockInputSchema = z
  .object({
    id,
    kind: z.enum(BLOCK_KINDS),
    body: z.string().max(2_000_000).nullable().optional(),
    assetId: id.nullable().optional(),
    remoteImageId: id.nullable().optional(),
    caption: optionalText(2_000),
  })
  .strict();
export type BlockInput = z.infer<typeof blockInputSchema>;

export const noteInputSchema = z
  .object({
    id,
    type: z.enum(NOTE_TYPES),
    title: optionalText(300),
    bodyMd: z.string().max(2_000_000),
  })
  .strict();
export type NoteInput = z.infer<typeof noteInputSchema>;

export const sourceLinkInputSchema = z
  .object({
    materialId: id,
    note: optionalText(2_000),
  })
  .strict();
export type SourceLinkInput = z.infer<typeof sourceLinkInputSchema>;

const baseEntityFields = {
  title: optionalText(300),
  subject: optionalText(50),
  stage: optionalText(50),
  sourceNote: optionalText(4_000),
  tags: z.array(z.string().max(60)).max(100).default([]),
  blocks: z.array(blockInputSchema).max(500).default([]),
  /** 本次编辑中产生、尚未归属对象的原始输入记录，保存时挂到该对象。 */
  rawInputIds: z.array(id).max(1_000).default([]),
};

export const problemCreateSchema = z
  .object({
    id,
    ...baseEntityFields,
    notes: z.array(noteInputSchema).max(500).default([]),
    sources: z.array(sourceLinkInputSchema).max(100).default([]),
  })
  .strict();
export type ProblemCreateInput = z.input<typeof problemCreateSchema>;

export const problemUpdateSchema = problemCreateSchema
  .omit({ id: true })
  .extend({ expectedVersion: z.number().int().min(1) })
  .strict();
export type ProblemUpdateInput = z.input<typeof problemUpdateSchema>;

export const materialCreateSchema = z
  .object({
    id,
    ...baseEntityFields,
    status: z.enum(MATERIAL_STATUSES).default('active'),
  })
  .strict();
export type MaterialCreateInput = z.input<typeof materialCreateSchema>;

export const materialUpdateSchema = materialCreateSchema
  .omit({ id: true })
  .extend({ expectedVersion: z.number().int().min(1) })
  .strict();
export type MaterialUpdateInput = z.input<typeof materialUpdateSchema>;

export const deriveProblemSchema = z
  .object({
    problemId: id,
    blockIds: z.array(id).min(1).max(500),
    note: optionalText(2_000),
    markMaterialActive: z.boolean().default(false),
  })
  .strict();

export const rawTextInputSchema = z
  .object({
    text: z.string().min(1).max(2_000_000),
    blockId: id.nullable().optional(),
  })
  .strict();

export const remoteImageCreateSchema = z
  .object({
    url: z.string().min(1).max(4_000),
    blockId: id.nullable().optional(),
  })
  .strict();

export const exportMarkdownSchema = z
  .object({
    problemIds: z.array(id).min(1).max(1_000),
  })
  .strict();

export const entityVersionSchema = z.object({ expectedVersion: z.number().int().min(1).optional() }).strict();

// ---------- 响应类型 ----------

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface AssetDTO {
  id: string;
  sha256: string;
  mime: AssetMime;
  size: number;
  originalFilename: string | null;
  createdAt: string;
}

export type RemoteImageStatus = 'pending' | 'archived' | 'failed';

export interface RemoteImageDTO {
  id: string;
  url: string;
  status: RemoteImageStatus;
  assetId: string | null;
  archivedVia: 'download' | 'manual' | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  updatedAt: string;
}

export interface BlockDTO {
  id: string;
  kind: BlockKind;
  body: string | null;
  assetId: string | null;
  remoteImageId: string | null;
  caption: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDTO {
  id: string;
  problemId: string;
  type: NoteType;
  title: string | null;
  bodyMd: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface RawInputDTO {
  id: string;
  kind: 'text' | 'file' | 'url';
  text: string | null;
  assetId: string | null;
  url: string | null;
  originalFilename: string | null;
  blockId: string | null;
  capturedAt: string;
}

export interface SourceLinkDTO {
  materialId: string;
  materialTitle: string | null;
  materialDeleted: boolean;
  note: string | null;
  createdAt: string;
}

export interface DerivedProblemDTO {
  problemId: string;
  title: string | null;
  deleted: boolean;
  createdAt: string;
}

interface EntityCommon {
  id: string;
  title: string | null;
  subject: string | null;
  stage: string | null;
  sourceNote: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
  tags: string[];
  blocks: BlockDTO[];
  /** blocks/notes 引用到的附件与远程图片，便于前端渲染。 */
  assets: Record<string, AssetDTO>;
  remoteImages: Record<string, RemoteImageDTO>;
  /** Markdown 中远程图片 URL → remote image id */
  remoteImageUrls: Record<string, string>;
  rawInputs: RawInputDTO[];
}

export interface ProblemDTO extends EntityCommon {
  notes: NoteDTO[];
  sources: SourceLinkDTO[];
}

export interface MaterialDTO extends EntityCommon {
  status: MaterialStatus;
  derivedProblems: DerivedProblemDTO[];
}

export interface SaveResult<T> {
  entity: T;
  created?: boolean;
  changed: boolean;
}

export interface ListItemDTO {
  id: string;
  title: string | null;
  subject: string | null;
  stage: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  summary: string;
  firstImageAssetId: string | null;
  blockCount: number;
  imageCount: number;
  noteCounts?: Record<NoteType, number>;
  status?: MaterialStatus;
  hits: SearchField[];
}

export interface ListResponse {
  items: ListItemDTO[];
  total: number;
  offset: number;
  limit: number;
}

export interface TagDTO {
  id: string;
  name: string;
  problemCount: number;
  materialCount: number;
}

export interface TrashDTO {
  problems: { id: string; title: string | null; summary: string; deletedAt: string }[];
  materials: { id: string; title: string | null; summary: string; deletedAt: string }[];
  notes: {
    id: string;
    problemId: string;
    problemTitle: string | null;
    problemDeleted: boolean;
    type: NoteType;
    title: string | null;
    summary: string;
    deletedAt: string;
  }[];
}

export interface SessionDTO {
  csrfToken: string;
  appVersion: string;
  schemaVersion: number;
  libraryId: string;
  dataDir: string;
  address: string;
  lastBackupAt: string | null;
  limits: {
    maxImageBytes: number;
    remoteTimeoutMs: number;
    maxRedirects: number;
    allowFakeIpDns: boolean;
  };
}

export interface BackupInfoDTO {
  fileName: string;
  size: number;
  createdAt: string;
}

export interface BackupResultDTO extends BackupInfoDTO {
  counts: Record<string, number>;
  assetFiles: number;
  unarchivedRemoteImages: { url: string; status: RemoteImageStatus; errorMessage: string | null }[];
}

export interface UploadResultDTO {
  asset: AssetDTO;
  rawInputId: string;
}

export interface TextFileImportDTO {
  rawInputId: string;
  asset: AssetDTO;
  text: string;
  kind: 'markdown' | 'text';
  missingLocalImages: string[];
  remoteImageUrls: string[];
}

export interface RemoteImageCreateDTO {
  remoteImage: RemoteImageDTO;
  asset: AssetDTO | null;
  rawInputId: string;
}
