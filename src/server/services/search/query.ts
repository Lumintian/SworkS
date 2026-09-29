/**
 * 列表查询：查询文本（查询语言）与旧的筛选参数取“且”，编译成一条参数化 SQL，一页一次查询（COUNT(*) OVER ()）。
 * 排序省略时：有正向自由词按相关度，否则按创建时间。当前页附带命中字段与命中片段。
 */
import type { ListIdsResponse, ListItemDTO, ListResponse } from '../../../shared/api.js';
import { SEARCH_FIELDS, type NoteType, type SearchField } from '../../../shared/constants.js';
import { filtersToAst, type ListFilters, type ListSort } from '../../../shared/listFilters.js';
import { andQ, positiveTexts, TRUE_Q, type Diagnostic, type Q } from '../../../shared/query/ast.js';
import { compileText, type QueryCatalog } from '../../../shared/query/resolve.js';
import type { DB } from '../../db/connection.js';
import { plainSummary } from '../markdown.js';
import { optionIndex, propertyDisplay, sortableOptionOrder, type OptionIndex } from '../properties.js';
import { ownerColumn, ownerTable, placeholders, tagTable, type BlockRow, type EntityRow, type OwnerKind } from '../rows.js';
import { attemptSummary } from '../students.js';
import { serverCatalog } from './catalog.js';
import { QueryCompiler, type Sql } from './compile.js';
import { collectFieldTexts } from './index.js';
import { makeSnippets } from './snippets.js';

export interface ListQuery extends Partial<ListFilters> {
  offset?: number | undefined;
  limit?: number | undefined;
  /** 直接给出语义条件（常用检索计数、MCP）；与 q 及其他参数取“且” */
  ast?: Q | undefined;
  /** 换算相对日期用的当前时间（测试用） */
  now?: Date | undefined;
}

/** 一次批量选择最多取回的 ID 数（与批量操作的上限一致）。 */
export const MAX_LIST_IDS = 1000;

interface Plan {
  where: Sql;
  order: Sql;
  sortApplied: ListSort;
  atoms: ReturnType<typeof positiveTexts>;
  diagnostics: Diagnostic[];
  studentId: string | null;
}

function plan(db: DB, kind: OwnerKind, query: ListQuery, catalog?: QueryCatalog): Plan {
  const compiler = new QueryCompiler(db, kind, query.now ?? new Date());
  const text = query.q?.trim() ?? '';
  const parsed = text ? compileText(text, catalog ?? serverCatalog(db), kind) : null;
  const full = andQ([
    filtersToAst(query),
    kind === 'material' && query.status ? { k: 'status', value: query.status } : TRUE_Q,
    query.ast ?? TRUE_Q,
    parsed?.q ?? TRUE_Q,
  ]);
  const cond = compiler.compile(full);
  const where: Sql = { sql: `e.deleted_at IS NULL AND ${cond.sql}`, params: [...cond.params] };
  // 旧参数 tags=<ID,…>：按标签 ID 精确匹配，全部包含
  const tagIds = [...new Set(query.tagIds ?? [])];
  if (tagIds.length) {
    const col = ownerColumn(kind);
    where.sql += ` AND e.id IN (SELECT x.${col} FROM ${tagTable(kind)} x WHERE x.tag_id IN (${placeholders(tagIds.length)}) GROUP BY x.${col} HAVING COUNT(DISTINCT x.tag_id) = ?)`;
    where.params.push(...tagIds, tagIds.length);
  }
  const atoms = positiveTexts(full);
  const hasFreeText = atoms.length > 0;
  let sortApplied: ListSort = query.sort ?? 'auto';
  if (sortApplied === 'auto') sortApplied = hasFreeText ? 'relevance' : 'created';
  if (sortApplied === 'relevance' && !hasFreeText) sortApplied = 'created';
  let order: Sql = { sql: 'e.created_at DESC, e.id DESC', params: [] };
  if (sortApplied === 'updated') order = { sql: 'e.updated_at DESC, e.id DESC', params: [] };
  else if (sortApplied === 'relevance') {
    const s = compiler.score(atoms);
    order = { sql: `${s.sql} DESC, e.updated_at DESC, e.id DESC`, params: s.params };
  } else if (sortApplied.startsWith('prop:')) {
    const pid = sortApplied.slice(5);
    const ids = sortableOptionOrder(db, pid);
    if (!ids) sortApplied = 'created';
    else if (ids.length) {
      // 按选项顺序升序（例如难度：容易 → 困难；分层时按深度优先顺序），未设置的排在最后。
      const rank = `(SELECT CASE v.option_id ${ids.map((_, i) => `WHEN ? THEN ${i}`).join(' ')} END FROM property_values v WHERE v.${ownerColumn(kind)} = e.id AND v.property_id = ?)`;
      order = { sql: `COALESCE(${rank}, 1000000000) ASC, e.created_at DESC, e.id DESC`, params: [...ids, pid] };
    }
  }
  return { where, order, sortApplied, atoms, diagnostics: parsed?.diagnostics ?? [], studentId: query.student || parsed?.studentId || null };
}

export function listEntities(db: DB, kind: OwnerKind, query: ListQuery): ListResponse {
  const table = ownerTable(kind);
  const p = plan(db, kind, query);
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const offset = Math.max(query.offset ?? 0, 0);
  const rows = db
    .prepare(`SELECT e.*, COUNT(*) OVER () AS _total FROM ${table} e WHERE ${p.where.sql} ORDER BY ${p.order.sql} LIMIT ? OFFSET ?`)
    .all(...p.where.params, ...p.order.params, limit, offset) as (EntityRow & { _total: number })[];
  const total =
    rows[0]?._total ?? (offset > 0 ? (db.prepare(`SELECT COUNT(*) AS n FROM ${table} e WHERE ${p.where.sql}`).get(...p.where.params) as { n: number }).n : 0);

  const idx = optionIndex(db);
  const items = rows.map((r) => buildListItem(db, kind, r, idx));
  if (kind === 'problem' && p.studentId) for (const it of items) it.attempt = attemptSummary(db, p.studentId, it.id);
  if (p.atoms.length && items.length) {
    attachHits(db, kind, items, p.atoms);
    for (const it of items) {
      const snippets = makeSnippets(collectFieldTexts(db, kind, it.id, idx), p.atoms);
      if (snippets.length) it.snippets = snippets;
    }
  }
  return { items, total, offset, limit, sortApplied: p.sortApplied, diagnostics: p.diagnostics, studentId: p.studentId };
}

/** 与列表相同的筛选与排序，只返回 ID（用于“选择全部 N 项”）。 */
export function listIds(db: DB, kind: OwnerKind, query: ListQuery): ListIdsResponse {
  const table = ownerTable(kind);
  const p = plan(db, kind, query);
  const rows = db
    .prepare(`SELECT e.id, COUNT(*) OVER () AS _total FROM ${table} e WHERE ${p.where.sql} ORDER BY ${p.order.sql} LIMIT ?`)
    .all(...p.where.params, ...p.order.params, MAX_LIST_IDS) as { id: string; _total: number }[];
  const total = rows[0]?._total ?? 0;
  return { ids: rows.map((r) => r.id), total, truncated: total > rows.length };
}

/** 只计数（常用检索的导航计数）。 */
export function countEntities(db: DB, kind: OwnerKind, query: ListQuery, catalog?: QueryCatalog): number {
  const p = plan(db, kind, query, catalog);
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${ownerTable(kind)} e WHERE ${p.where.sql}`).get(...p.where.params) as { n: number }).n;
}

function buildListItem(db: DB, kind: OwnerKind, r: EntityRow, idx: OptionIndex): ListItemDTO {
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
          ((db.prepare('SELECT asset_id FROM remote_images WHERE id = ?').get(b.remote_image_id) as { asset_id: string | null } | undefined)?.asset_id ?? null);
      }
      if (!summary && b.caption) summary = b.caption;
    } else if (!summary && b.body) {
      summary = b.kind === 'markdown' ? plainSummary(b.body) : b.body.replace(/\s+/g, ' ').trim().slice(0, 140);
    }
  }
  const tags = (
    db.prepare(`SELECT t.name FROM ${tagTable(kind)} x JOIN tags t ON t.id = x.tag_id WHERE x.${col} = ? ORDER BY t.name COLLATE NOCASE`).all(r.id) as { name: string }[]
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
    properties: propertyDisplay(db, { kind, id: r.id }, idx).map((p) => ({ propertyId: p.propertyId, values: p.values })),
    hits: [],
  };
  if (kind === 'problem') {
    const counts: Record<NoteType, number> = { note: 0, answer: 0, solution: 0 };
    for (const c of db.prepare('SELECT type, COUNT(*) AS n FROM notes WHERE problem_id = ? AND deleted_at IS NULL GROUP BY type').all(r.id) as { type: NoteType; n: number }[]) {
      counts[c.type] = c.n;
    }
    item.noteCounts = counts;
  } else if (r.status) {
    item.status = r.status;
  }
  return item;
}

/** 当前页各项命中了哪些字段 */
function attachHits(db: DB, kind: OwnerKind, items: ListItemDTO[], atoms: readonly { value: string; fields?: readonly SearchField[] }[]): void {
  const ids = items.map((i) => i.id);
  const rows = db
    .prepare(`SELECT owner_id, field, text FROM search_index WHERE owner_kind = ? AND owner_id IN (${placeholders(ids.length)})`)
    .all(kind, ...ids) as { owner_id: string; field: SearchField; text: string }[];
  const hits = new Map<string, Set<SearchField>>();
  for (const r of rows) {
    if (!atoms.some((a) => (!a.fields || a.fields.includes(r.field)) && r.text.includes(a.value))) continue;
    const set = hits.get(r.owner_id) ?? new Set();
    set.add(r.field);
    hits.set(r.owner_id, set);
  }
  for (const i of items) i.hits = [...(hits.get(i.id) ?? [])].sort((a, b) => SEARCH_FIELDS.indexOf(a) - SEARCH_FIELDS.indexOf(b));
}
