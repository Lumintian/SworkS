/**
 * 检索：可重建的 search_index 投影 + 参数化子串查询（instr），不拼接用户输入，不使用 LIKE 通配。
 * 文本匹配与标签条件分开实现。
 */
import type { ListIdsResponse, ListItemDTO, ListResponse } from '../../shared/api.js';
import { SEARCH_FIELDS, type NoteType, type SearchField } from '../../shared/constants.js';
import { NONE_VALUE, TRUE_VALUE, type ListFilters } from '../../shared/listFilters.js';
import { inSubtree, tagKey } from '../../shared/tagPath.js';
import type { DB } from '../db/connection.js';
import { plainSummary } from './markdown.js';
import { expandOptionFilter, isSortableProperty, propertyDisplay, propertyIndexTexts } from './properties.js';
import { attemptFilterSql, attemptSummary } from './students.js';
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
  for (const text of propertyIndexTexts(db, { kind, id })) push('property', text);
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

export interface ListQuery extends Partial<ListFilters> {
  offset?: number | undefined;
  limit?: number | undefined;
}

/** 一次批量选择最多取回的 ID 数（与批量操作的上限一致）。 */
export const MAX_LIST_IDS = 1000;

/** 把标签路径展开为其子树内全部标签的 ID（大小写与段空白按 tagKey 统一）。 */
export function expandTagPaths(db: DB, paths: readonly string[]): string[][] {
  if (paths.length === 0) return [];
  const all = (db.prepare('SELECT id, name FROM tags').all() as { id: string; name: string }[]).map((t) => ({
    id: t.id,
    key: tagKey(t.name),
  }));
  return paths.map((p) => {
    const pk = tagKey(p);
    return all.filter((t) => inSubtree(t.key, pk)).map((t) => t.id);
  });
}

interface WhereClause {
  sql: string;
  params: unknown[];
  keywords: string[];
}

function buildWhere(db: DB, kind: OwnerKind, query: ListQuery): WhereClause {
  const where: string[] = ['e.deleted_at IS NULL'];
  const params: unknown[] = [];
  const col = ownerColumn(kind);
  const scalar = (column: 'subject' | 'stage', value: string | undefined) => {
    if (!value) return;
    if (value === NONE_VALUE) where.push(`e.${column} IS NULL`);
    else {
      where.push(`e.${column} = ?`);
      params.push(value);
    }
  };
  scalar('subject', query.subject);
  scalar('stage', query.stage);
  if (kind === 'material' && query.status) {
    where.push('e.status = ?');
    params.push(query.status);
  }
  const tagIds = [...new Set(query.tagIds ?? [])];
  if (tagIds.length > 0) {
    // 多标签按 AND：必须包含全部所选标签
    where.push(
      `e.id IN (SELECT x.${col} FROM ${tagTable(kind)} x WHERE x.tag_id IN (${placeholders(tagIds.length)}) GROUP BY x.${col} HAVING COUNT(DISTINCT x.tag_id) = ?)`,
    );
    params.push(...tagIds, tagIds.length);
  }
  // 标签路径：每个路径命中其子树内任一标签；多个路径按 AND
  for (const ids of expandTagPaths(db, query.tagPaths ?? [])) {
    if (ids.length === 0) {
      where.push('0');
      continue;
    }
    where.push(`EXISTS (SELECT 1 FROM ${tagTable(kind)} x WHERE x.${col} = e.id AND x.tag_id IN (${placeholders(ids.length)}))`);
    params.push(...ids);
  }
  if (query.untagged) where.push(`NOT EXISTS (SELECT 1 FROM ${tagTable(kind)} x WHERE x.${col} = e.id)`);
  // 属性：同一属性内的多个值为“或”（选项含子树），不同属性之间为“且”
  for (const pf of query.props ?? []) {
    const ors: string[] = [];
    const optionIds = expandOptionFilter(
      db,
      pf.propertyId,
      pf.values.filter((v) => v !== NONE_VALUE && v !== TRUE_VALUE),
    );
    if (optionIds.length) {
      ors.push(`EXISTS (SELECT 1 FROM property_values v WHERE v.${col} = e.id AND v.property_id = ? AND v.option_id IN (${placeholders(optionIds.length)}))`);
      params.push(pf.propertyId, ...optionIds);
    }
    if (pf.values.includes(TRUE_VALUE)) {
      ors.push(`EXISTS (SELECT 1 FROM property_values v WHERE v.${col} = e.id AND v.property_id = ? AND v.number_value = 1)`);
      params.push(pf.propertyId);
    }
    if (pf.values.includes(NONE_VALUE)) {
      ors.push(`NOT EXISTS (SELECT 1 FROM property_values v WHERE v.${col} = e.id AND v.property_id = ?)`);
      params.push(pf.propertyId);
    }
    where.push(ors.length ? `(${ors.join(' OR ')})` : '0');
  }
  // 学生的作答状态（只对题目有效）
  if (kind === 'problem' && query.student && query.attempt) {
    const f = attemptFilterSql(query.student, query.attempt);
    if (f) {
      where.push(f.sql);
      params.push(...f.params);
    }
  }
  const keywords = splitKeywords(query.q);
  for (const k of keywords) {
    // 多个关键词按 AND；每个关键词可命中任意字段
    where.push(
      'EXISTS (SELECT 1 FROM search_index s WHERE s.owner_kind = ? AND s.owner_id = e.id AND instr(s.text, ?) > 0)',
    );
    params.push(kind, k);
  }
  return { sql: where.join(' AND '), params, keywords };
}

/** 排序子句与其参数。按属性排序时，属性 ID 作为参数绑定，不拼进 SQL。 */
function orderSql(db: DB, kind: OwnerKind, query: ListQuery): { sql: string; params: unknown[] } {
  if (query.sort?.startsWith('prop:')) {
    const pid = query.sort.slice(5);
    if (isSortableProperty(db, pid)) {
      // 按选项顺序升序（例如难度：容易 → 困难），未设置的排在最后
      const pos = `(SELECT o.position FROM property_values v JOIN property_options o ON o.id = v.option_id WHERE v.${ownerColumn(kind)} = e.id AND v.property_id = ?)`;
      return { sql: `${pos} IS NULL, ${pos} ASC, e.created_at DESC, e.id DESC`, params: [pid, pid] };
    }
  }
  const col = query.sort === 'updated' ? 'e.updated_at' : 'e.created_at';
  return { sql: `${col} DESC, e.id DESC`, params: [] };
}

export function listEntities(db: DB, kind: OwnerKind, query: ListQuery): ListResponse {
  const table = ownerTable(kind);
  const where = buildWhere(db, kind, query);
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} e WHERE ${where.sql}`).get(...where.params) as { n: number }).n;
  const order = orderSql(db, kind, query);
  const rows = db
    .prepare(`SELECT e.* FROM ${table} e WHERE ${where.sql} ORDER BY ${order.sql} LIMIT ? OFFSET ?`)
    .all(...where.params, ...order.params, limit, offset) as EntityRow[];

  const items = rows.map((r) => buildListItem(db, kind, r));
  if (kind === 'problem' && query.student) for (const it of items) it.attempt = attemptSummary(db, query.student, it.id);
  if (where.keywords.length > 0 && items.length > 0) attachHits(db, kind, items, where.keywords);
  return { items, total, offset, limit };
}

/** 与列表相同的筛选与排序，只返回 ID（用于“选择全部 N 项”）。 */
export function listIds(db: DB, kind: OwnerKind, query: ListQuery): ListIdsResponse {
  const table = ownerTable(kind);
  const where = buildWhere(db, kind, query);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} e WHERE ${where.sql}`).get(...where.params) as { n: number }).n;
  const order = orderSql(db, kind, query);
  const ids = (
    db
      .prepare(`SELECT e.id FROM ${table} e WHERE ${where.sql} ORDER BY ${order.sql} LIMIT ?`)
      .all(...where.params, ...order.params, MAX_LIST_IDS) as { id: string }[]
  ).map((r) => r.id);
  return { ids, total, truncated: total > ids.length };
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
    properties: propertyDisplay(db, { kind, id: r.id }).map((p) => ({ propertyId: p.propertyId, values: p.values })),
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
  for (const i of items) i.hits.sort((a, b) => SEARCH_FIELDS.indexOf(a) - SEARCH_FIELDS.indexOf(b));
}
