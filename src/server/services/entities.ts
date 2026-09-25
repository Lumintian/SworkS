/**
 * 题目与资料的聚合读写。
 * - 客户端生成稳定 ID，创建请求可安全重试（同 ID 不会产生第二条记录）。
 * - 更新使用 write_version 条件更新，陈旧页面不能静默覆盖新内容。
 * - 题目、内容块、所属 Note 的任何修改都会递增该题 write_version 并刷新 updated_at。
 */
import { randomUUID } from 'node:crypto';
import type {
  AssetDTO,
  BlockInput,
  MaterialDTO,
  NoteInput,
  ProblemDTO,
  RemoteImageDTO,
  SaveResult,
  SourceLinkInput,
} from '../../shared/api.js';
import { parseAssetRef } from '../../shared/assetRef.js';
import type { MaterialStatus } from '../../shared/constants.js';
import type { AppContext } from '../context.js';
import { nowIso, type DB } from '../db/connection.js';
import { AppError } from '../errors.js';
import { toAssetDTO, type AssetRow } from './assetStore.js';
import { extractImageRefs, remoteImageUrls } from './markdown.js';
import { reindex } from './search.js';
import {
  normalizeShortText,
  normalizeTagNames,
  ownerColumn,
  ownerTable,
  placeholders,
  tagTable,
  toBlockDTO,
  toNoteDTO,
  toRawInputDTO,
  toRemoteImageDTO,
  type BlockRow,
  type EntityRow,
  type NoteRow,
  type Owner,
  type OwnerKind,
  type RawInputRow,
  type RemoteImageRow,
} from './rows.js';

// ---------------------------------------------------------------- 读取

function getEntityRow(db: DB, kind: OwnerKind, id: string): EntityRow | undefined {
  return db.prepare(`SELECT * FROM ${ownerTable(kind)} WHERE id = ?`).get(id) as EntityRow | undefined;
}

function loadBlocks(db: DB, owner: Owner): BlockRow[] {
  return db
    .prepare(`SELECT * FROM content_blocks WHERE ${ownerColumn(owner.kind)} = ? ORDER BY position`)
    .all(owner.id) as BlockRow[];
}

function loadLiveNotes(db: DB, problemId: string): NoteRow[] {
  return db
    .prepare('SELECT * FROM notes WHERE problem_id = ? AND deleted_at IS NULL ORDER BY position, created_at, id')
    .all(problemId) as NoteRow[];
}

function loadTags(db: DB, owner: Owner): string[] {
  return (
    db
      .prepare(
        `SELECT t.name FROM ${tagTable(owner.kind)} x JOIN tags t ON t.id = x.tag_id WHERE x.${ownerColumn(owner.kind)} = ? ORDER BY t.name COLLATE NOCASE`,
      )
      .all(owner.id) as { name: string }[]
  ).map((r) => r.name);
}

interface Refs {
  assets: Record<string, AssetDTO>;
  remoteImages: Record<string, RemoteImageDTO>;
  remoteImageUrls: Record<string, string>;
}

function collectRefs(db: DB, blocks: BlockRow[], markdownSources: string[]): Refs {
  const assetIds = new Set<string>();
  const remoteIds = new Set<string>();
  const urls = new Set<string>();
  for (const b of blocks) {
    if (b.asset_id) assetIds.add(b.asset_id);
    if (b.remote_image_id) remoteIds.add(b.remote_image_id);
  }
  for (const md of markdownSources) {
    for (const ref of extractImageRefs(md)) {
      if (ref.kind === 'asset') {
        const id = parseAssetRef(ref.url);
        if (id) assetIds.add(id);
      } else if (ref.kind === 'remote') {
        urls.add(ref.url.trim());
      }
    }
  }
  const remoteRows: RemoteImageRow[] = [];
  if (remoteIds.size > 0) {
    remoteRows.push(
      ...(db
        .prepare(`SELECT * FROM remote_images WHERE id IN (${placeholders(remoteIds.size)})`)
        .all(...remoteIds) as RemoteImageRow[]),
    );
  }
  const remoteImageUrls: Record<string, string> = {};
  if (urls.size > 0) {
    const rows = db
      .prepare(`SELECT * FROM remote_images WHERE url IN (${placeholders(urls.size)})`)
      .all(...urls) as RemoteImageRow[];
    for (const r of rows) {
      remoteImageUrls[r.url] = r.id;
      remoteRows.push(r);
    }
  }
  const remoteImages: Record<string, RemoteImageDTO> = {};
  for (const r of remoteRows) {
    remoteImages[r.id] = toRemoteImageDTO(r);
    if (r.asset_id) assetIds.add(r.asset_id);
  }
  const assets: Record<string, AssetDTO> = {};
  if (assetIds.size > 0) {
    for (const a of db
      .prepare(`SELECT * FROM assets WHERE id IN (${placeholders(assetIds.size)})`)
      .all(...assetIds) as AssetRow[]) {
      assets[a.id] = toAssetDTO(a);
    }
  }
  return { assets, remoteImages, remoteImageUrls };
}

export function loadProblem(db: DB, id: string): ProblemDTO | null {
  const row = getEntityRow(db, 'problem', id);
  if (!row) return null;
  const owner: Owner = { kind: 'problem', id };
  const blocks = loadBlocks(db, owner);
  const notes = loadLiveNotes(db, id);
  const sources = db
    .prepare(
      `SELECT l.material_id, l.note, l.created_at, m.title AS material_title, m.deleted_at AS material_deleted_at
       FROM problem_material_links l JOIN materials m ON m.id = l.material_id
       WHERE l.problem_id = ? ORDER BY l.created_at, l.material_id`,
    )
    .all(id) as {
    material_id: string;
    note: string | null;
    created_at: string;
    material_title: string | null;
    material_deleted_at: string | null;
  }[];
  const rawInputs = db
    .prepare('SELECT * FROM raw_inputs WHERE problem_id = ? ORDER BY captured_at, id')
    .all(id) as RawInputRow[];
  const md = [
    ...blocks.filter((b) => b.kind === 'markdown').map((b) => b.body ?? ''),
    ...notes.map((n) => n.body_md),
  ];
  const refs = collectRefs(db, blocks, md);
  for (const r of rawInputs) {
    if (r.asset_id && !refs.assets[r.asset_id]) {
      const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(r.asset_id) as AssetRow | undefined;
      if (a) refs.assets[a.id] = toAssetDTO(a);
    }
  }
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    stage: row.stage,
    sourceNote: row.source_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: row.write_version,
    tags: loadTags(db, owner),
    blocks: blocks.map(toBlockDTO),
    notes: notes.map(toNoteDTO),
    sources: sources.map((s) => ({
      materialId: s.material_id,
      materialTitle: s.material_title,
      materialDeleted: s.material_deleted_at !== null,
      note: s.note,
      createdAt: s.created_at,
    })),
    rawInputs: rawInputs.map(toRawInputDTO),
    ...refs,
  };
}

export function loadMaterial(db: DB, id: string): MaterialDTO | null {
  const row = getEntityRow(db, 'material', id);
  if (!row) return null;
  const owner: Owner = { kind: 'material', id };
  const blocks = loadBlocks(db, owner);
  const rawInputs = db
    .prepare('SELECT * FROM raw_inputs WHERE material_id = ? ORDER BY captured_at, id')
    .all(id) as RawInputRow[];
  const derived = db
    .prepare(
      `SELECT p.id, p.title, p.deleted_at, l.created_at FROM problem_material_links l JOIN problems p ON p.id = l.problem_id
       WHERE l.material_id = ? ORDER BY l.created_at, p.id`,
    )
    .all(id) as { id: string; title: string | null; deleted_at: string | null; created_at: string }[];
  const refs = collectRefs(
    db,
    blocks,
    blocks.filter((b) => b.kind === 'markdown').map((b) => b.body ?? ''),
  );
  for (const r of rawInputs) {
    if (r.asset_id && !refs.assets[r.asset_id]) {
      const a = db.prepare('SELECT * FROM assets WHERE id = ?').get(r.asset_id) as AssetRow | undefined;
      if (a) refs.assets[a.id] = toAssetDTO(a);
    }
  }
  return {
    id: row.id,
    title: row.title,
    subject: row.subject,
    stage: row.stage,
    sourceNote: row.source_note,
    status: row.status ?? 'active',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: row.write_version,
    tags: loadTags(db, owner),
    blocks: blocks.map(toBlockDTO),
    rawInputs: rawInputs.map(toRawInputDTO),
    derivedProblems: derived.map((d) => ({
      problemId: d.id,
      title: d.title,
      deleted: d.deleted_at !== null,
      createdAt: d.created_at,
    })),
    ...refs,
  };
}

// ---------------------------------------------------------------- 写入辅助

interface NormalizedBlock {
  id: string;
  kind: BlockRow['kind'];
  body: string | null;
  asset_id: string | null;
  remote_image_id: string | null;
  caption: string | null;
}

function normalizeBlock(db: DB, b: BlockInput): NormalizedBlock {
  if (b.kind === 'image') {
    const assetId = b.assetId ?? null;
    const remoteId = b.remoteImageId ?? null;
    if ((assetId === null) === (remoteId === null)) {
      throw new AppError('VALIDATION', '图片块必须且只能引用一个本地附件或一条远程图片记录');
    }
    if (assetId) {
      const a = db.prepare('SELECT mime FROM assets WHERE id = ?').get(assetId) as { mime: string } | undefined;
      if (!a) throw new AppError('VALIDATION', `图片附件不存在：${assetId}`);
      if (!a.mime.startsWith('image/')) throw new AppError('VALIDATION', '图片块只能引用图片附件');
    }
    if (remoteId && !db.prepare('SELECT 1 FROM remote_images WHERE id = ?').get(remoteId)) {
      throw new AppError('VALIDATION', `远程图片记录不存在：${remoteId}`);
    }
    return {
      id: b.id,
      kind: 'image',
      body: null,
      asset_id: assetId,
      remote_image_id: remoteId,
      caption: normalizeShortText(b.caption),
    };
  }
  if (b.assetId || b.remoteImageId) throw new AppError('VALIDATION', '文字块不能引用图片附件');
  return { id: b.id, kind: b.kind, body: b.body ?? '', asset_id: null, remote_image_id: null, caption: null };
}

function sameBlock(a: NormalizedBlock, r: BlockRow): boolean {
  return (
    a.kind === r.kind &&
    a.body === r.body &&
    a.asset_id === r.asset_id &&
    a.remote_image_id === r.remote_image_id &&
    a.caption === r.caption
  );
}

function assertUniqueIds(ids: string[], what: string): void {
  if (new Set(ids).size !== ids.length) throw new AppError('VALIDATION', `${what} ID 重复`);
}

/** 以给定顺序整体写入内容块；返回是否有改动。 */
function writeBlocks(db: DB, owner: Owner, input: BlockInput[], now: string): boolean {
  const col = ownerColumn(owner.kind);
  assertUniqueIds(input.map((b) => b.id), '内容块');
  const blocks = input.map((b) => normalizeBlock(db, b));
  const existing = new Map(loadBlocks(db, owner).map((r) => [r.id, r]));
  const foreign = db.prepare('SELECT problem_id, material_id FROM content_blocks WHERE id = ?');
  for (const b of blocks) {
    if (existing.has(b.id)) continue;
    const other = foreign.get(b.id) as { problem_id: string | null; material_id: string | null } | undefined;
    if (other) throw new AppError('VALIDATION', `内容块 ${b.id} 已属于其他对象`);
  }
  let changed = false;
  const keep = new Set(blocks.map((b) => b.id));
  const del = db.prepare('DELETE FROM content_blocks WHERE id = ?');
  for (const id of existing.keys()) {
    if (!keep.has(id)) {
      del.run(id);
      changed = true;
    }
  }
  const orderChanged = blocks.some((b, i) => existing.get(b.id)?.position !== i && existing.has(b.id));
  if (orderChanged) changed = true;
  // 先把位置移到负数区，避免重排时触发唯一索引冲突
  db.prepare(`UPDATE content_blocks SET position = -1 - position WHERE ${col} = ?`).run(owner.id);
  const update = db.prepare(
    `UPDATE content_blocks SET position = @position, kind = @kind, body = @body, asset_id = @asset_id,
       remote_image_id = @remote_image_id, caption = @caption, updated_at = @updated_at WHERE id = @id`,
  );
  const insert = db.prepare(
    `INSERT INTO content_blocks (id, ${col}, position, kind, body, asset_id, remote_image_id, caption, created_at, updated_at)
     VALUES (@id, @owner, @position, @kind, @body, @asset_id, @remote_image_id, @caption, @now, @now)`,
  );
  blocks.forEach((b, position) => {
    const prev = existing.get(b.id);
    if (prev) {
      const same = sameBlock(b, prev);
      if (!same) changed = true;
      update.run({ ...b, position, updated_at: same ? prev.updated_at : now });
    } else {
      changed = true;
      insert.run({ ...b, owner: owner.id, position, now });
    }
  });
  return changed;
}

function writeTags(db: DB, owner: Owner, names: string[]): boolean {
  const table = tagTable(owner.kind);
  const col = ownerColumn(owner.kind);
  const wanted = normalizeTagNames(names);
  const find = db.prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE');
  const createTag = db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)');
  const ids: string[] = [];
  for (const name of wanted) {
    const row = find.get(name) as { id: string } | undefined;
    if (row) ids.push(row.id);
    else {
      const id = randomUUID();
      createTag.run(id, name, nowIso());
      ids.push(id);
    }
  }
  const current = new Set(
    (db.prepare(`SELECT tag_id FROM ${table} WHERE ${col} = ?`).all(owner.id) as { tag_id: string }[]).map((r) => r.tag_id),
  );
  const want = new Set(ids);
  let changed = false;
  for (const id of current) {
    if (!want.has(id)) {
      db.prepare(`DELETE FROM ${table} WHERE ${col} = ? AND tag_id = ?`).run(owner.id, id);
      changed = true;
    }
  }
  for (const id of want) {
    if (!current.has(id)) {
      db.prepare(`INSERT INTO ${table} (${col}, tag_id) VALUES (?, ?)`).run(owner.id, id);
      changed = true;
    }
  }
  return changed;
}

function writeNotes(db: DB, problemId: string, input: NoteInput[], now: string): boolean {
  assertUniqueIds(input.map((n) => n.id), '笔记');
  const all = new Map(
    (db.prepare('SELECT * FROM notes WHERE problem_id = ?').all(problemId) as NoteRow[]).map((n) => [n.id, n]),
  );
  const foreign = db.prepare('SELECT problem_id FROM notes WHERE id = ?');
  for (const n of input) {
    if (all.has(n.id)) continue;
    if (foreign.get(n.id)) throw new AppError('VALIDATION', `笔记 ${n.id} 属于其他题目`);
  }
  let changed = false;
  const keep = new Set(input.map((n) => n.id));
  const softDelete = db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ?');
  for (const n of all.values()) {
    if (n.deleted_at === null && !keep.has(n.id)) {
      softDelete.run(now, n.id);
      changed = true;
    }
  }
  const update = db.prepare(
    `UPDATE notes SET type = @type, title = @title, body_md = @body_md, position = @position,
       deleted_at = NULL, updated_at = @updated_at WHERE id = @id`,
  );
  const insert = db.prepare(
    `INSERT INTO notes (id, problem_id, type, title, body_md, position, created_at, updated_at, deleted_at)
     VALUES (@id, @problem_id, @type, @title, @body_md, @position, @now, @now, NULL)`,
  );
  input.forEach((n, position) => {
    const title = normalizeShortText(n.title);
    const prev = all.get(n.id);
    if (prev) {
      const same =
        prev.deleted_at === null && prev.type === n.type && prev.title === title && prev.body_md === n.bodyMd;
      if (!same || prev.position !== position) changed = true;
      update.run({ id: n.id, type: n.type, title, body_md: n.bodyMd, position, updated_at: same ? prev.updated_at : now });
    } else {
      changed = true;
      insert.run({ id: n.id, problem_id: problemId, type: n.type, title, body_md: n.bodyMd, position, now });
    }
  });
  return changed;
}

function writeSources(db: DB, problemId: string, input: SourceLinkInput[], now: string): boolean {
  assertUniqueIds(input.map((s) => s.materialId), '来源资料');
  const current = new Map(
    (
      db.prepare('SELECT material_id, note FROM problem_material_links WHERE problem_id = ?').all(problemId) as {
        material_id: string;
        note: string | null;
      }[]
    ).map((r) => [r.material_id, r.note]),
  );
  let changed = false;
  const want = new Map(input.map((s) => [s.materialId, normalizeShortText(s.note)]));
  for (const id of current.keys()) {
    if (!want.has(id)) {
      db.prepare('DELETE FROM problem_material_links WHERE problem_id = ? AND material_id = ?').run(problemId, id);
      changed = true;
    }
  }
  for (const [materialId, note] of want) {
    if (current.has(materialId)) {
      if (current.get(materialId) !== note) {
        db.prepare('UPDATE problem_material_links SET note = ? WHERE problem_id = ? AND material_id = ?').run(
          note,
          problemId,
          materialId,
        );
        changed = true;
      }
      continue;
    }
    const m = db.prepare('SELECT deleted_at FROM materials WHERE id = ?').get(materialId) as
      | { deleted_at: string | null }
      | undefined;
    if (!m) throw new AppError('VALIDATION', `来源资料不存在：${materialId}`);
    if (m.deleted_at) throw new AppError('VALIDATION', '不能关联回收站中的资料');
    db.prepare('INSERT INTO problem_material_links (problem_id, material_id, note, created_at) VALUES (?, ?, ?, ?)').run(
      problemId,
      materialId,
      note,
      now,
    );
    changed = true;
  }
  return changed;
}

function linkRawInputs(db: DB, owner: Owner, ids: string[]): void {
  if (ids.length === 0) return;
  db.prepare(
    `UPDATE raw_inputs SET ${ownerColumn(owner.kind)} = ?
     WHERE id IN (${placeholders(ids.length)}) AND problem_id IS NULL AND material_id IS NULL`,
  ).run(owner.id, ...ids);
}

/** 为 Markdown 中的远程图片建立归档记录；返回新建的记录 ID。 */
export function ensureRemoteImages(db: DB, urls: string[]): string[] {
  const created: string[] = [];
  const find = db.prepare('SELECT id FROM remote_images WHERE url = ?');
  const insert = db.prepare(
    `INSERT INTO remote_images (id, url, status, attempts, created_at, updated_at) VALUES (?, ?, 'pending', 0, ?, ?)`,
  );
  for (const url of urls) {
    if (find.get(url)) continue;
    const id = randomUUID();
    const now = nowIso();
    insert.run(id, url, now, now);
    created.push(id);
  }
  return created;
}

function markdownSourcesOf(blocks: BlockInput[], notes: NoteInput[] = []): string[] {
  return [
    ...blocks.filter((b) => b.kind === 'markdown').map((b) => b.body ?? ''),
    ...notes.map((n) => n.bodyMd),
  ];
}

function scheduleRemote(ctx: AppContext, ids: string[]): void {
  for (const id of ids) ctx.archiver.enqueue(id);
}

// ---------------------------------------------------------------- 题目

export interface ProblemWrite {
  title?: string | null | undefined;
  subject?: string | null | undefined;
  stage?: string | null | undefined;
  sourceNote?: string | null | undefined;
  tags: string[];
  blocks: BlockInput[];
  notes: NoteInput[];
  sources: SourceLinkInput[];
  rawInputIds: string[];
}

export function createProblem(ctx: AppContext, id: string, input: ProblemWrite): SaveResult<ProblemDTO> {
  const { db } = ctx;
  let remoteIds: string[] = [];
  const created = db.transaction(() => {
    if (getEntityRow(db, 'problem', id)) return false;
    const now = nowIso();
    db.prepare(
      `INSERT INTO problems (id, title, subject, stage, source_note, created_at, updated_at, deleted_at, write_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
    ).run(
      id,
      normalizeShortText(input.title),
      normalizeShortText(input.subject),
      normalizeShortText(input.stage),
      normalizeShortText(input.sourceNote),
      now,
      now,
    );
    const owner: Owner = { kind: 'problem', id };
    writeBlocks(db, owner, input.blocks, now);
    writeTags(db, owner, input.tags);
    writeNotes(db, id, input.notes, now);
    writeSources(db, id, input.sources, now);
    linkRawInputs(db, owner, input.rawInputIds);
    remoteIds = ensureRemoteImages(db, markdownSourcesOf(input.blocks, input.notes).flatMap(remoteImageUrls));
    reindex(db, 'problem', id);
    return true;
  })();
  scheduleRemote(ctx, remoteIds);
  return { entity: loadProblem(db, id)!, created, changed: created };
}

export function updateProblem(
  ctx: AppContext,
  id: string,
  expectedVersion: number,
  input: ProblemWrite,
): SaveResult<ProblemDTO> {
  const { db } = ctx;
  let remoteIds: string[] = [];
  const changed = db.transaction(() => {
    const row = getEntityRow(db, 'problem', id);
    if (!row) throw new AppError('NOT_FOUND', '题目不存在');
    if (row.deleted_at) throw new AppError('CONFLICT', '该题目已在回收站中，请先恢复再编辑', { details: { currentVersion: row.write_version } });
    if (row.write_version !== expectedVersion) {
      throw new AppError('CONFLICT', '该题目已在其他页面被修改，本页内容未保存', {
        details: { currentVersion: row.write_version, expectedVersion },
      });
    }
    const now = nowIso();
    const owner: Owner = { kind: 'problem', id };
    const fields = {
      title: normalizeShortText(input.title),
      subject: normalizeShortText(input.subject),
      stage: normalizeShortText(input.stage),
      source_note: normalizeShortText(input.sourceNote),
    };
    let changed =
      fields.title !== row.title ||
      fields.subject !== row.subject ||
      fields.stage !== row.stage ||
      fields.source_note !== row.source_note;
    if (changed) {
      db.prepare('UPDATE problems SET title = ?, subject = ?, stage = ?, source_note = ? WHERE id = ?').run(
        fields.title,
        fields.subject,
        fields.stage,
        fields.source_note,
        id,
      );
    }
    changed = writeBlocks(db, owner, input.blocks, now) || changed;
    changed = writeTags(db, owner, input.tags) || changed;
    changed = writeNotes(db, id, input.notes, now) || changed;
    changed = writeSources(db, id, input.sources, now) || changed;
    linkRawInputs(db, owner, input.rawInputIds);
    if (changed) {
      db.prepare('UPDATE problems SET updated_at = ?, write_version = write_version + 1 WHERE id = ?').run(now, id);
      remoteIds = ensureRemoteImages(db, markdownSourcesOf(input.blocks, input.notes).flatMap(remoteImageUrls));
      reindex(db, 'problem', id);
    }
    return changed;
  })();
  scheduleRemote(ctx, remoteIds);
  return { entity: loadProblem(db, id)!, changed };
}

// ---------------------------------------------------------------- 资料

export interface MaterialWrite {
  title?: string | null | undefined;
  subject?: string | null | undefined;
  stage?: string | null | undefined;
  sourceNote?: string | null | undefined;
  status: MaterialStatus;
  tags: string[];
  blocks: BlockInput[];
  rawInputIds: string[];
}

export function createMaterial(ctx: AppContext, id: string, input: MaterialWrite): SaveResult<MaterialDTO> {
  const { db } = ctx;
  let remoteIds: string[] = [];
  const created = db.transaction(() => {
    if (getEntityRow(db, 'material', id)) return false;
    const now = nowIso();
    db.prepare(
      `INSERT INTO materials (id, title, subject, stage, source_note, status, created_at, updated_at, deleted_at, write_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
    ).run(
      id,
      normalizeShortText(input.title),
      normalizeShortText(input.subject),
      normalizeShortText(input.stage),
      normalizeShortText(input.sourceNote),
      input.status,
      now,
      now,
    );
    const owner: Owner = { kind: 'material', id };
    writeBlocks(db, owner, input.blocks, now);
    writeTags(db, owner, input.tags);
    linkRawInputs(db, owner, input.rawInputIds);
    remoteIds = ensureRemoteImages(db, markdownSourcesOf(input.blocks).flatMap(remoteImageUrls));
    reindex(db, 'material', id);
    return true;
  })();
  scheduleRemote(ctx, remoteIds);
  return { entity: loadMaterial(db, id)!, created, changed: created };
}

export function updateMaterial(
  ctx: AppContext,
  id: string,
  expectedVersion: number,
  input: MaterialWrite,
): SaveResult<MaterialDTO> {
  const { db } = ctx;
  let remoteIds: string[] = [];
  const changed = db.transaction(() => {
    const row = getEntityRow(db, 'material', id);
    if (!row) throw new AppError('NOT_FOUND', '资料不存在');
    if (row.deleted_at) throw new AppError('CONFLICT', '该资料已在回收站中，请先恢复再编辑', { details: { currentVersion: row.write_version } });
    if (row.write_version !== expectedVersion) {
      throw new AppError('CONFLICT', '该资料已在其他页面被修改，本页内容未保存', {
        details: { currentVersion: row.write_version, expectedVersion },
      });
    }
    const now = nowIso();
    const owner: Owner = { kind: 'material', id };
    const fields = {
      title: normalizeShortText(input.title),
      subject: normalizeShortText(input.subject),
      stage: normalizeShortText(input.stage),
      source_note: normalizeShortText(input.sourceNote),
      status: input.status,
    };
    let changed =
      fields.title !== row.title ||
      fields.subject !== row.subject ||
      fields.stage !== row.stage ||
      fields.source_note !== row.source_note ||
      fields.status !== row.status;
    if (changed) {
      db.prepare('UPDATE materials SET title = ?, subject = ?, stage = ?, source_note = ?, status = ? WHERE id = ?').run(
        fields.title,
        fields.subject,
        fields.stage,
        fields.source_note,
        fields.status,
        id,
      );
    }
    changed = writeBlocks(db, owner, input.blocks, now) || changed;
    changed = writeTags(db, owner, input.tags) || changed;
    linkRawInputs(db, owner, input.rawInputIds);
    if (changed) {
      db.prepare('UPDATE materials SET updated_at = ?, write_version = write_version + 1 WHERE id = ?').run(now, id);
      remoteIds = ensureRemoteImages(db, markdownSourcesOf(input.blocks).flatMap(remoteImageUrls));
      reindex(db, 'material', id);
    }
    return changed;
  })();
  scheduleRemote(ctx, remoteIds);
  return { entity: loadMaterial(db, id)!, changed };
}

/**
 * 从资料建立题目：复制选定的完整内容块（新块 ID，引用同一附件），保留来源关系。
 * 题目与资料此后各自编辑，互不联动。
 */
export function deriveProblemFromMaterial(
  ctx: AppContext,
  materialId: string,
  input: { problemId: string; blockIds: string[]; note?: string | null | undefined; markMaterialActive: boolean },
): SaveResult<ProblemDTO> {
  const { db } = ctx;
  const created = db.transaction(() => {
    const existing = getEntityRow(db, 'problem', input.problemId);
    if (existing) {
      const linked = db
        .prepare('SELECT 1 FROM problem_material_links WHERE problem_id = ? AND material_id = ?')
        .get(input.problemId, materialId);
      if (!linked) throw new AppError('CONFLICT', '题目 ID 已被占用');
      return false;
    }
    const material = getEntityRow(db, 'material', materialId);
    if (!material) throw new AppError('NOT_FOUND', '资料不存在');
    if (material.deleted_at) throw new AppError('CONFLICT', '资料在回收站中，不能建题');
    const selected = new Set(input.blockIds);
    const blocks = loadBlocks(db, { kind: 'material', id: materialId }).filter((b) => selected.has(b.id));
    if (blocks.length !== selected.size) throw new AppError('VALIDATION', '所选内容块不属于该资料');
    const now = nowIso();
    db.prepare(
      `INSERT INTO problems (id, title, subject, stage, source_note, created_at, updated_at, deleted_at, write_version)
       VALUES (?, NULL, ?, ?, NULL, ?, ?, NULL, 1)`,
    ).run(input.problemId, material.subject, material.stage, now, now);
    writeBlocks(
      db,
      { kind: 'problem', id: input.problemId },
      blocks.map((b) => ({
        id: randomUUID(),
        kind: b.kind,
        body: b.body,
        assetId: b.asset_id,
        remoteImageId: b.remote_image_id,
        caption: b.caption,
      })),
      now,
    );
    db.prepare('INSERT INTO problem_material_links (problem_id, material_id, note, created_at) VALUES (?, ?, ?, ?)').run(
      input.problemId,
      materialId,
      normalizeShortText(input.note),
      now,
    );
    reindex(db, 'problem', input.problemId);
    if (input.markMaterialActive && material.status !== 'active') {
      db.prepare(
        "UPDATE materials SET status = 'active', updated_at = ?, write_version = write_version + 1 WHERE id = ?",
      ).run(now, materialId);
    }
    return true;
  })();
  return { entity: loadProblem(db, input.problemId)!, created, changed: created };
}

// ---------------------------------------------------------------- 软删除与恢复

export function setDeleted(ctx: AppContext, kind: OwnerKind, id: string, deleted: boolean): number {
  const { db } = ctx;
  return db.transaction(() => {
    const row = getEntityRow(db, kind, id);
    if (!row) throw new AppError('NOT_FOUND', kind === 'problem' ? '题目不存在' : '资料不存在');
    if ((row.deleted_at !== null) === deleted) return row.write_version;
    db.prepare(`UPDATE ${ownerTable(kind)} SET deleted_at = ?, write_version = write_version + 1 WHERE id = ?`).run(
      deleted ? nowIso() : null,
      id,
    );
    return row.write_version + 1;
  })();
}

export function restoreNote(ctx: AppContext, noteId: string): ProblemDTO {
  const { db } = ctx;
  const problemId = db.transaction(() => {
    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(noteId) as NoteRow | undefined;
    if (!note) throw new AppError('NOT_FOUND', '笔记不存在');
    if (note.deleted_at === null) return note.problem_id;
    const max = db
      .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM notes WHERE problem_id = ? AND deleted_at IS NULL')
      .get(note.problem_id) as { m: number };
    const now = nowIso();
    db.prepare('UPDATE notes SET deleted_at = NULL, position = ?, updated_at = ? WHERE id = ?').run(max.m + 1, now, noteId);
    db.prepare('UPDATE problems SET updated_at = ?, write_version = write_version + 1 WHERE id = ?').run(now, note.problem_id);
    reindex(db, 'problem', note.problem_id);
    return note.problem_id;
  })();
  return loadProblem(db, problemId)!;
}
