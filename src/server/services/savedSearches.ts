/**
 * 常用检索：保存查询的语义树（属性/选项/学生用 ID，标签用路径，日期保存原样的写法）与当时的文本。
 * 显示与打开时按当前名称重新生成文本，所以属性、选项、学生改名后依然有效；
 * 标签改名/合并/删除、学科学段改名/合并、选项合并时，在同一事务里改写保存的条件（见 rewriteSavedSearches）。
 */
import type { SavedSearchDTO, SavedSearchScope } from '../../shared/api.js';
import { parseListFilters, type ListSort } from '../../shared/listFilters.js';
import { mapQ, type Q } from '../../shared/query/ast.js';
import { compileText, type QueryCatalog } from '../../shared/query/resolve.js';
import { serializeQuery } from '../../shared/query/serialize.js';
import { nowIso, type DB } from '../db/connection.js';
import { AppError } from '../errors.js';
import { recordCatalog } from '../events/changes.js';
import { countEntities, serverCatalog } from './search.js';

interface Row {
  id: string;
  scope: SavedSearchScope;
  name: string;
  query_json: string;
  sort: string | null;
  position: number;
  show_in_nav: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface StoredQuery {
  v: 1;
  text: string;
  ast: Q;
}

function parseStored(json: string): StoredQuery {
  const v = JSON.parse(json) as StoredQuery;
  return v && v.v === 1 && v.ast ? v : { v: 1, text: '', ast: { k: 'false', reason: '无法读取保存的条件' } };
}

function toDTO(r: Row, catalog: QueryCatalog): SavedSearchDTO {
  const stored = parseStored(r.query_json);
  const s = serializeQuery(stored.ast, catalog);
  return {
    id: r.id,
    scope: r.scope,
    name: r.name,
    text: s.text,
    sort: (r.sort as ListSort | null) ?? null,
    position: r.position,
    showInNav: r.show_in_nav === 1,
    problems: s.problems,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function normalizeSort(sort: string | null | undefined): string | null {
  if (!sort) return null;
  const s = parseListFilters(new URLSearchParams({ sort })).sort;
  return s === 'auto' ? null : s;
}

function normalizeName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n || n.length > 60) throw new AppError('VALIDATION', '名称应为 1–60 个字');
  return n;
}

/** 解析查询文本；有错误时拒绝保存（避免保存一个查不到任何东西的条件） */
function compileForSave(db: DB, scope: SavedSearchScope, text: string, catalog = serverCatalog(db)): StoredQuery {
  const r = compileText(text, catalog, scope);
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  if (errors.length) throw new AppError('VALIDATION', `查询有错误：${errors.map((e) => e.message).join('；')}`, { details: errors });
  if (r.q.k === 'true') throw new AppError('VALIDATION', '查询为空');
  return { v: 1, text, ast: r.q };
}

function assertUniqueName(db: DB, scope: SavedSearchScope, name: string, exceptId?: string): void {
  const clash = db.prepare('SELECT id FROM saved_searches WHERE scope = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL').get(scope, name) as { id: string } | undefined;
  if (clash && clash.id !== exceptId) throw new AppError('CONFLICT', `已有名为“${name}”的常用检索`);
}

function getRow(db: DB, id: string): Row {
  const r = db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(id) as Row | undefined;
  if (!r || r.deleted_at) throw new AppError('NOT_FOUND', '常用检索不存在');
  return r;
}

export function listSavedSearches(db: DB, scope?: SavedSearchScope): SavedSearchDTO[] {
  const rows = (
    scope
      ? db.prepare('SELECT * FROM saved_searches WHERE deleted_at IS NULL AND scope = ? ORDER BY position, created_at, id').all(scope)
      : db.prepare('SELECT * FROM saved_searches WHERE deleted_at IS NULL ORDER BY scope, position, created_at, id').all()
  ) as Row[];
  const catalog = serverCatalog(db);
  return rows.map((r) => toDTO(r, catalog));
}

export function createSavedSearch(
  db: DB,
  input: { id: string; scope: SavedSearchScope; name: string; text: string; sort?: string | null | undefined; showInNav?: boolean | undefined },
): { savedSearch: SavedSearchDTO; created: boolean } {
  const id = input.id.toLowerCase();
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM saved_searches WHERE id = ?').get(id) as Row | undefined;
    if (existing) return { savedSearch: toDTO(existing, serverCatalog(db)), created: false };
    recordCatalog(db, 'savedSearches');
    const name = normalizeName(input.name);
    assertUniqueName(db, input.scope, name);
    const stored = compileForSave(db, input.scope, input.text);
    const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM saved_searches WHERE scope = ? AND deleted_at IS NULL').get(input.scope) as { m: number };
    const now = nowIso();
    db.prepare(
      `INSERT INTO saved_searches (id, scope, name, query_json, sort, position, show_in_nav, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(id, input.scope, name, JSON.stringify(stored), normalizeSort(input.sort), max.m + 1, input.showInNav === false ? 0 : 1, now, now);
    return { savedSearch: toDTO(getRow(db, id), serverCatalog(db)), created: true };
  })();
}

export function updateSavedSearch(
  db: DB,
  id: string,
  input: { name?: string | undefined; text?: string | undefined; sort?: string | null | undefined; showInNav?: boolean | undefined },
): SavedSearchDTO {
  return db.transaction(() => {
    recordCatalog(db, 'savedSearches');
    const r = getRow(db, id);
    const name = input.name !== undefined ? normalizeName(input.name) : r.name;
    if (name !== r.name) assertUniqueName(db, r.scope, name, r.id);
    const json = input.text !== undefined ? JSON.stringify(compileForSave(db, r.scope, input.text)) : r.query_json;
    const sort = input.sort !== undefined ? normalizeSort(input.sort) : r.sort;
    const show = input.showInNav !== undefined ? (input.showInNav ? 1 : 0) : r.show_in_nav;
    db.prepare('UPDATE saved_searches SET name = ?, query_json = ?, sort = ?, show_in_nav = ?, updated_at = ? WHERE id = ?').run(name, json, sort, show, nowIso(), r.id);
    return toDTO(getRow(db, r.id), serverCatalog(db));
  })();
}

/** 软删除 */
export function deleteSavedSearch(db: DB, id: string): void {
  db.transaction(() => {
    recordCatalog(db, 'savedSearches');
    const r = getRow(db, id);
    db.prepare('UPDATE saved_searches SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), r.id);
  })();
}

export function reorderSavedSearches(db: DB, scope: SavedSearchScope, ids: readonly string[]): void {
  db.transaction(() => {
    recordCatalog(db, 'savedSearches');
    const all = (db.prepare('SELECT id FROM saved_searches WHERE scope = ? AND deleted_at IS NULL ORDER BY position, created_at, id').all(scope) as { id: string }[]).map((r) => r.id);
    const wanted = ids.map((i) => i.toLowerCase()).filter((i) => all.includes(i));
    const order = [...new Set(wanted), ...all.filter((i) => !wanted.includes(i))];
    const set = db.prepare('UPDATE saved_searches SET position = ? WHERE id = ?');
    order.forEach((id, i) => set.run(i, id));
  })();
}

/** 导航里显示的计数 */
export function savedSearchCounts(db: DB, scope: SavedSearchScope): Record<string, number> {
  const rows = db.prepare('SELECT * FROM saved_searches WHERE deleted_at IS NULL AND scope = ? AND show_in_nav = 1').all(scope) as Row[];
  const catalog = serverCatalog(db);
  const out: Record<string, number> = {};
  for (const r of rows) out[r.id] = countEntities(db, scope, { ast: parseStored(r.query_json).ast }, catalog);
  return out;
}

/**
 * 在当前事务里改写所有常用检索的条件（标签、字典改名/合并/删除，选项合并时调用）。
 * 只写真正变化的行；文本按当前名称重新生成。
 */
export function rewriteSavedSearches(db: DB, fn: (q: Q) => Q): number {
  const rows = db.prepare('SELECT id, query_json FROM saved_searches WHERE deleted_at IS NULL').all() as Pick<Row, 'id' | 'query_json'>[];
  if (rows.length === 0) return 0;
  let catalog: QueryCatalog | null = null;
  let changed = 0;
  for (const r of rows) {
    const stored = parseStored(r.query_json);
    const next = mapQ(stored.ast, fn);
    if (JSON.stringify(next) === JSON.stringify(stored.ast)) continue;
    catalog ??= serverCatalog(db);
    const text = serializeQuery(next, catalog).text;
    db.prepare('UPDATE saved_searches SET query_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ v: 1, text, ast: next }), nowIso(), r.id);
    changed++;
  }
  if (changed) recordCatalog(db, 'savedSearches');
  return changed;
}
