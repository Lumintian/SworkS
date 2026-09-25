/**
 * 检索：可重建的 search_index 投影 + 参数化子串查询（instr），不拼接用户输入，不使用 LIKE 通配。
 * 文本匹配与标签条件分开实现。
 */
import type { ListItemDTO, ListResponse } from '../../shared/api.js';
import type { MaterialStatus, NoteType, SearchField } from '../../shared/constants.js';
import type { DB } from '../db/connection.js';
import { plainSummary } from './markdown.js';
import {
  ownerColumn,
  ownerTable,
  placeholders,
  tagTable,
  type BlockRow,
  type EntityRow,
  type NoteRow,
  type OwnerKind,
} from './rows.js';

/** 统一的大小写折叠：英文不区分大小写，中文按原字匹配。 */
export function foldCase(text: string): string {
  return text.toLowerCase();
}

export function splitKeywords(q: string | undefined | null): string[] {
  if (!q) return [];
  const seen = new Set<string>();
  for (const part of q.split(/\s+/)) {
    const k = foldCase(part.trim());
    if (k) seen.add(k);
  }
  return [...seen].slice(0, 20);
}

interface IndexRow {
  field: SearchField;
  text: string;
}

function collectRows(db: DB, kind: OwnerKind, id: string): IndexRow[] {
  const entity = db.prepare(`SELECT * FROM ${ownerTable(kind)} WHERE id = ?`).get(id) as EntityRow | undefined;
  if (!entity) return [];
  const rows: IndexRow[] = [];
  const push = (field: SearchField, text: string | null | undefined) => {
    if (text && text.trim()) rows.push({ field, text: foldCase(text) });
  };
  push('title', entity.title);
  push('source', entity.source_note);
  const blocks = db
    .prepare(`SELECT * FROM content_blocks WHERE ${ownerColumn(kind)} = ? ORDER BY position`)
    .all(id) as BlockRow[];
  for (const b of blocks) {
    if (b.kind === 'image') push('content', b.caption);
    else push('content', b.body);
  }
  const tags = db
    .prepare(`SELECT t.name FROM ${tagTable(kind)} x JOIN tags t ON t.id = x.tag_id WHERE x.${ownerColumn(kind)} = ?`)
    .all(id) as { name: string }[];
  for (const t of tags) push('tag', t.name);
  if (kind === 'problem') {
    const notes = db
      .prepare('SELECT type, title, body_md FROM notes WHERE problem_id = ? AND deleted_at IS NULL')
      .all(id) as Pick<NoteRow, 'type' | 'title' | 'body_md'>[];
    for (const n of notes) {
      push(n.type, n.title);
      push(n.type, n.body_md);
    }
    const links = db
      .prepare('SELECT note FROM problem_material_links WHERE problem_id = ?')
      .all(id) as { note: string | null }[];
    for (const l of links) push('source', l.note);
  }
  return rows;
}

/** 重建某个对象的检索投影；应在保存事务内调用。 */
export function reindex(db: DB, kind: OwnerKind, id: string): void {
  db.prepare('DELETE FROM search_index WHERE owner_kind = ? AND owner_id = ?').run(kind, id);
  const insert = db.prepare('INSERT INTO search_index (owner_kind, owner_id, field, text) VALUES (?, ?, ?, ?)');
  for (const r of collectRows(db, kind, id)) insert.run(kind, id, r.field, r.text);
}

export function reindexAll(db: DB): void {
  db.transaction(() => {
    db.prepare('DELETE FROM search_index').run();
    for (const { id } of db.prepare('SELECT id FROM problems').all() as { id: string }[]) reindex(db, 'problem', id);
    for (const { id } of db.prepare('SELECT id FROM materials').all() as { id: string }[]) reindex(db, 'material', id);
  })();
}

export interface ListQuery {
  q?: string | undefined;
  subject?: string | undefined;
  stage?: string | undefined;
  tagIds?: string[] | undefined;
  sort?: 'created' | 'updated' | undefined;
  offset?: number | undefined;
  limit?: number | undefined;
  status?: MaterialStatus | undefined;
}

export function listEntities(db: DB, kind: OwnerKind, query: ListQuery): ListResponse {
  const table = ownerTable(kind);
  const where: string[] = ['e.deleted_at IS NULL'];
  const params: unknown[] = [];
  if (query.subject) {
    where.push('e.subject = ?');
    params.push(query.subject);
  }
  if (query.stage) {
    where.push('e.stage = ?');
    params.push(query.stage);
  }
  if (kind === 'material' && query.status) {
    where.push('e.status = ?');
    params.push(query.status);
  }
  const tagIds = [...new Set(query.tagIds ?? [])];
  if (tagIds.length > 0) {
    // 多标签按 AND：必须包含全部所选标签
    where.push(
      `e.id IN (SELECT x.${ownerColumn(kind)} FROM ${tagTable(kind)} x WHERE x.tag_id IN (${placeholders(tagIds.length)}) GROUP BY x.${ownerColumn(kind)} HAVING COUNT(DISTINCT x.tag_id) = ?)`,
    );
    params.push(...tagIds, tagIds.length);
  }
  const keywords = splitKeywords(query.q);
  for (const k of keywords) {
    // 多个关键词按 AND；每个关键词可命中任意字段
    where.push(
      'EXISTS (SELECT 1 FROM search_index s WHERE s.owner_kind = ? AND s.owner_id = e.id AND instr(s.text, ?) > 0)',
    );
    params.push(kind, k);
  }
  const whereSql = where.join(' AND ');
  const orderCol = query.sort === 'updated' ? 'e.updated_at' : 'e.created_at';
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} e WHERE ${whereSql}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT e.* FROM ${table} e WHERE ${whereSql} ORDER BY ${orderCol} DESC, e.id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as EntityRow[];

  const items = rows.map((r) => buildListItem(db, kind, r));
  if (keywords.length > 0 && items.length > 0) attachHits(db, kind, items, keywords);
  return { items, total, offset, limit };
}

function buildListItem(db: DB, kind: OwnerKind, r: EntityRow): ListItemDTO {
  const col = ownerColumn(kind);
  const blocks = db
    .prepare(`SELECT kind, body, asset_id, remote_image_id, caption FROM content_blocks WHERE ${col} = ? ORDER BY position`)
    .all(r.id) as Pick<BlockRow, 'kind' | 'body' | 'asset_id' | 'remote_image_id' | 'caption'>[];
  let summary = '';
  let firstImageAssetId: string | null = null;
  let imageCount = 0;
  for (const b of blocks) {
    if (b.kind === 'image') {
      imageCount++;
      if (!firstImageAssetId) {
        firstImageAssetId =
          b.asset_id ??
          ((db.prepare('SELECT asset_id FROM remote_images WHERE id = ?').get(b.remote_image_id) as { asset_id: string | null } | undefined)
            ?.asset_id ?? null);
      }
      if (!summary && b.caption) summary = b.caption;
    } else if (!summary && b.body) {
      summary = b.kind === 'markdown' ? plainSummary(b.body) : b.body.replace(/\s+/g, ' ').trim().slice(0, 140);
    }
  }
  const tags = (
    db
      .prepare(`SELECT t.name FROM ${tagTable(kind)} x JOIN tags t ON t.id = x.tag_id WHERE x.${col} = ? ORDER BY t.name COLLATE NOCASE`)
      .all(r.id) as { name: string }[]
  ).map((t) => t.name);
  const item: ListItemDTO = {
    id: r.id,
    title: r.title,
    subject: r.subject,
    stage: r.stage,
    tags,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    summary,
    firstImageAssetId,
    blockCount: blocks.length,
    imageCount,
    hits: [],
  };
  if (kind === 'problem') {
    const counts: Record<NoteType, number> = { note: 0, answer: 0, solution: 0 };
    for (const c of db
      .prepare('SELECT type, COUNT(*) AS n FROM notes WHERE problem_id = ? AND deleted_at IS NULL GROUP BY type')
      .all(r.id) as { type: NoteType; n: number }[]) {
      counts[c.type] = c.n;
    }
    item.noteCounts = counts;
  } else if (r.status) {
    item.status = r.status;
  }
  return item;
}

function attachHits(db: DB, kind: OwnerKind, items: ListItemDTO[], keywords: string[]): void {
  const ids = items.map((i) => i.id);
  const cond = keywords.map(() => 'instr(text, ?) > 0').join(' OR ');
  const rows = db
    .prepare(
      `SELECT DISTINCT owner_id, field FROM search_index WHERE owner_kind = ? AND owner_id IN (${placeholders(ids.length)}) AND (${cond})`,
    )
    .all(kind, ...ids, ...keywords) as { owner_id: string; field: SearchField }[];
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const r of rows) byId.get(r.owner_id)?.hits.push(r.field);
  const order: SearchField[] = ['title', 'content', 'note', 'answer', 'solution', 'tag', 'source'];
  for (const i of items) i.hits.sort((a, b) => order.indexOf(a) - order.indexOf(b));
}
