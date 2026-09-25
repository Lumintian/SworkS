import type { BlockKind, MaterialStatus, NoteType } from '../../shared/constants.js';
import type { BlockDTO, NoteDTO, RawInputDTO, RemoteImageDTO } from '../../shared/api.js';

export type OwnerKind = 'problem' | 'material';
export interface Owner {
  kind: OwnerKind;
  id: string;
}

export function ownerColumn(kind: OwnerKind): 'problem_id' | 'material_id' {
  return kind === 'problem' ? 'problem_id' : 'material_id';
}

export function ownerTable(kind: OwnerKind): 'problems' | 'materials' {
  return kind === 'problem' ? 'problems' : 'materials';
}

export function tagTable(kind: OwnerKind): 'problem_tags' | 'material_tags' {
  return kind === 'problem' ? 'problem_tags' : 'material_tags';
}

export interface EntityRow {
  id: string;
  title: string | null;
  subject: string | null;
  stage: string | null;
  source_note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  write_version: number;
  status?: MaterialStatus;
}

export interface BlockRow {
  id: string;
  problem_id: string | null;
  material_id: string | null;
  position: number;
  kind: BlockKind;
  body: string | null;
  asset_id: string | null;
  remote_image_id: string | null;
  caption: string | null;
  created_at: string;
  updated_at: string;
}

export interface NoteRow {
  id: string;
  problem_id: string;
  type: NoteType;
  title: string | null;
  body_md: string;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface RemoteImageRow {
  id: string;
  url: string;
  status: 'pending' | 'archived' | 'failed';
  asset_id: string | null;
  archived_via: 'download' | 'manual' | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

export interface RawInputRow {
  id: string;
  kind: 'text' | 'file' | 'url';
  text: string | null;
  asset_id: string | null;
  url: string | null;
  original_filename: string | null;
  problem_id: string | null;
  material_id: string | null;
  block_id: string | null;
  captured_at: string;
}

export function toBlockDTO(r: BlockRow): BlockDTO {
  return {
    id: r.id,
    kind: r.kind,
    body: r.body,
    assetId: r.asset_id,
    remoteImageId: r.remote_image_id,
    caption: r.caption,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function toNoteDTO(r: NoteRow): NoteDTO {
  return {
    id: r.id,
    problemId: r.problem_id,
    type: r.type,
    title: r.title,
    bodyMd: r.body_md,
    position: r.position,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
  };
}

export function toRemoteImageDTO(r: RemoteImageRow): RemoteImageDTO {
  return {
    id: r.id,
    url: r.url,
    status: r.status,
    assetId: r.asset_id,
    archivedVia: r.archived_via,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    attempts: r.attempts,
    updatedAt: r.updated_at,
  };
}

export function toRawInputDTO(r: RawInputRow): RawInputDTO {
  return {
    id: r.id,
    kind: r.kind,
    text: r.text,
    assetId: r.asset_id,
    url: r.url,
    originalFilename: r.original_filename,
    blockId: r.block_id,
    capturedAt: r.captured_at,
  };
}

/** 生成 `(?, ?, ?)` 占位符。 */
export function placeholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(', ');
}

/** 标题/属性类短文本：去首尾空白，空串视为 NULL。正文不做此处理。 */
export function normalizeShortText(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = v.trim();
  return t === '' ? null : t;
}

export function normalizeTagNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}
