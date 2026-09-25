/** 编辑页的草稿模型：与服务端 DTO 互转，并生成用于比较“是否有未保存修改”的规范化载荷。 */
import type { AssetDTO, BlockDTO, MaterialDTO, ProblemDTO, RemoteImageDTO } from '@shared/api';
import type { BlockKind, MaterialStatus, NoteType } from '@shared/constants';
import { newId } from './format';

export interface DraftBlock {
  id: string;
  kind: BlockKind;
  body: string;
  assetId: string | null;
  remoteImageId: string | null;
  caption: string;
}

export interface DraftNote {
  id: string;
  type: NoteType;
  title: string;
  bodyMd: string;
}

export interface DraftSource {
  materialId: string;
  materialTitle: string | null;
  materialDeleted: boolean;
  note: string;
}

export interface BaseDraft {
  title: string;
  subject: string;
  stage: string;
  sourceNote: string;
  tags: string[];
  blocks: DraftBlock[];
}

export interface ProblemDraft extends BaseDraft {
  notes: DraftNote[];
  sources: DraftSource[];
}

export interface MaterialDraft extends BaseDraft {
  status: MaterialStatus;
}

export interface Refs {
  assets: Record<string, AssetDTO>;
  remoteImages: Record<string, RemoteImageDTO>;
  remoteImageUrls: Record<string, string>;
}

export const emptyRefs = (): Refs => ({ assets: {}, remoteImages: {}, remoteImageUrls: {} });

export function mergeRefs(a: Refs, b: Partial<Refs>): Refs {
  return {
    assets: { ...a.assets, ...b.assets },
    remoteImages: { ...a.remoteImages, ...b.remoteImages },
    remoteImageUrls: { ...a.remoteImageUrls, ...b.remoteImageUrls },
  };
}

export function blockFromDTO(b: BlockDTO): DraftBlock {
  return {
    id: b.id,
    kind: b.kind,
    body: b.body ?? '',
    assetId: b.assetId,
    remoteImageId: b.remoteImageId,
    caption: b.caption ?? '',
  };
}

export function newBlock(kind: BlockKind, init: Partial<DraftBlock> = {}): DraftBlock {
  return { id: newId(), kind, body: '', assetId: null, remoteImageId: null, caption: '', ...init };
}

export function newNote(type: NoteType): DraftNote {
  return { id: newId(), type, title: '', bodyMd: '' };
}

export function problemDraftFromDTO(p: ProblemDTO): ProblemDraft {
  return {
    title: p.title ?? '',
    subject: p.subject ?? '',
    stage: p.stage ?? '',
    sourceNote: p.sourceNote ?? '',
    tags: [...p.tags],
    blocks: p.blocks.map(blockFromDTO),
    notes: p.notes.map((n) => ({ id: n.id, type: n.type, title: n.title ?? '', bodyMd: n.bodyMd })),
    sources: p.sources.map((s) => ({
      materialId: s.materialId,
      materialTitle: s.materialTitle,
      materialDeleted: s.materialDeleted,
      note: s.note ?? '',
    })),
  };
}

export function materialDraftFromDTO(m: MaterialDTO): MaterialDraft {
  return {
    title: m.title ?? '',
    subject: m.subject ?? '',
    stage: m.stage ?? '',
    sourceNote: m.sourceNote ?? '',
    tags: [...m.tags],
    blocks: m.blocks.map(blockFromDTO),
    status: m.status,
  };
}

export function emptyProblemDraft(): ProblemDraft {
  return { title: '', subject: '', stage: '', sourceNote: '', tags: [], blocks: [], notes: [], sources: [] };
}

export function emptyMaterialDraft(status: MaterialStatus): MaterialDraft {
  return { title: '', subject: '', stage: '', sourceNote: '', tags: [], blocks: [], status };
}

const short = (v: string) => (v.trim() === '' ? null : v.trim());

function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const name = t.replace(/\s+/g, ' ').trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { sensitivity: 'base' }));
}

function blockPayload(b: DraftBlock) {
  if (b.kind === 'image') {
    return { id: b.id, kind: b.kind, assetId: b.assetId, remoteImageId: b.remoteImageId, caption: short(b.caption) };
  }
  return { id: b.id, kind: b.kind, body: b.body };
}

function basePayload(d: BaseDraft) {
  return {
    title: short(d.title),
    subject: short(d.subject),
    stage: short(d.stage),
    sourceNote: short(d.sourceNote),
    tags: normalizeTags(d.tags),
    blocks: d.blocks.map(blockPayload),
  };
}

export function problemPayload(d: ProblemDraft) {
  return {
    ...basePayload(d),
    notes: d.notes.map((n) => ({ id: n.id, type: n.type, title: short(n.title), bodyMd: n.bodyMd })),
    sources: [...d.sources]
      .sort((a, b) => a.materialId.localeCompare(b.materialId))
      .map((s) => ({ materialId: s.materialId, note: short(s.note) })),
  };
}

export function materialPayload(d: MaterialDraft) {
  return { ...basePayload(d), status: d.status };
}

export function isDraftEmpty(d: BaseDraft & { notes?: DraftNote[] }): boolean {
  return (
    !d.title.trim() &&
    d.tags.length === 0 &&
    !d.sourceNote.trim() &&
    d.blocks.every((b) => b.kind !== 'image' && !b.body.trim()) &&
    (d.notes ?? []).every((n) => !n.bodyMd.trim() && !n.title.trim())
  );
}

/** 冲突时“另存为新对象”：换用新的块/笔记 ID，避免与原对象冲突。 */
export function cloneWithNewIds<D extends BaseDraft & { notes?: DraftNote[] }>(d: D): D {
  return {
    ...d,
    blocks: d.blocks.map((b) => ({ ...b, id: newId() })),
    ...(d.notes ? { notes: d.notes.map((n) => ({ ...n, id: newId() })) } : {}),
  };
}

/** 把草稿整理为可复制的纯文本，供冲突或失败时手动保存。 */
export function draftAsText(d: BaseDraft & { notes?: DraftNote[] }): string {
  const parts: string[] = [];
  if (d.title.trim()) parts.push(`# ${d.title.trim()}`);
  for (const b of d.blocks) {
    if (b.kind === 'image') parts.push(`[图片 ${b.assetId ?? b.remoteImageId}]${b.caption ? ` ${b.caption}` : ''}`);
    else parts.push(b.body);
  }
  for (const n of d.notes ?? []) parts.push(`## ${n.type}${n.title ? `：${n.title}` : ''}\n\n${n.bodyMd}`);
  return parts.join('\n\n');
}
