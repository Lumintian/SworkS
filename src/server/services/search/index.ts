/**
 * 检索投影（search_index）：由正文派生，可随时重建，不进备份。
 * 每个字段的文字经 normText 规范化（NFKC + 小写 + 折叠空白）后存入，查询词用同一个函数处理。
 * 规则变化时递增 SEARCH_INDEX_VERSION，打开库时按需整体重建。
 */
import type { SearchField } from '../../../shared/constants.js';
import { normText } from '../../../shared/query/normalize.js';
import type { DB } from '../../db/connection.js';
import { getMeta, setMeta } from '../../db/migrations.js';
import { optionIndex, propertyIndexTexts, type OptionIndex } from '../properties.js';
import { ownerColumn, ownerTable, tagTable, type BlockRow, type EntityRow, type NoteRow, type OwnerKind } from '../rows.js';

/** 1：只小写；2：NFKC + 小写 + 折叠空白 */
export const SEARCH_INDEX_VERSION = 2;
const META_KEY = 'search_index_version';

export interface FieldText {
  field: SearchField;
  text: string;
}

/** 对象各字段的原文（未规范化）：检索投影与命中片段共用。 */
export function collectFieldTexts(db: DB, kind: OwnerKind, id: string, idx?: OptionIndex): FieldText[] {
  const entity = db.prepare(`SELECT * FROM ${ownerTable(kind)} WHERE id = ?`).get(id) as EntityRow | undefined;
  if (!entity) return [];
  const rows: FieldText[] = [];
  const push = (field: SearchField, text: string | null | undefined) => {
    if (text && text.trim()) rows.push({ field, text });
  };
  push('title', entity.title);
  push('source', entity.source_note);
  const blocks = db.prepare(`SELECT * FROM content_blocks WHERE ${ownerColumn(kind)} = ? ORDER BY position`).all(id) as BlockRow[];
  for (const b of blocks) push('content', b.kind === 'image' ? b.caption : b.body);
  const tags = db
    .prepare(`SELECT t.name FROM ${tagTable(kind)} x JOIN tags t ON t.id = x.tag_id WHERE x.${ownerColumn(kind)} = ?`)
    .all(id) as { name: string }[];
  for (const t of tags) push('tag', t.name);
  for (const text of propertyIndexTexts(db, { kind, id }, idx)) push('property', text);
  if (kind === 'problem') {
    const notes = db
      .prepare('SELECT type, title, body_md FROM notes WHERE problem_id = ? AND deleted_at IS NULL ORDER BY position')
      .all(id) as Pick<NoteRow, 'type' | 'title' | 'body_md'>[];
    for (const n of notes) {
      push(n.type, n.title);
      push(n.type, n.body_md);
    }
    const links = db.prepare('SELECT note FROM problem_material_links WHERE problem_id = ?').all(id) as { note: string | null }[];
    for (const l of links) push('source', l.note);
  }
  return rows;
}

/** 重建某个对象的检索投影；应在保存事务内调用。 */
export function reindex(db: DB, kind: OwnerKind, id: string, idx?: OptionIndex): void {
  db.prepare('DELETE FROM search_index WHERE owner_kind = ? AND owner_id = ?').run(kind, id);
  const insert = db.prepare('INSERT INTO search_index (owner_kind, owner_id, field, text) VALUES (?, ?, ?, ?)');
  for (const r of collectFieldTexts(db, kind, id, idx)) {
    const t = normText(r.text);
    if (t) insert.run(kind, id, r.field, t);
  }
}

/** 整体重建（共用一份选项路径表）。不写版本标记：由调用方在合适的时机调用 markSearchIndexCurrent。 */
export function reindexAll(db: DB): void {
  db.transaction(() => {
    const idx = optionIndex(db);
    db.prepare('DELETE FROM search_index').run();
    for (const { id } of db.prepare('SELECT id FROM problems').all() as { id: string }[]) reindex(db, 'problem', id, idx);
    for (const { id } of db.prepare('SELECT id FROM materials').all() as { id: string }[]) reindex(db, 'material', id, idx);
  })();
}

export function markSearchIndexCurrent(db: DB): void {
  setMeta(db, META_KEY, String(SEARCH_INDEX_VERSION));
}

/** 打开库时调用：检索规则变了（或从未记录版本）就整体重建。返回是否重建。 */
export function ensureSearchIndexVersion(db: DB, log?: (msg: string) => void): boolean {
  if (getMeta(db, META_KEY) === String(SEARCH_INDEX_VERSION)) return false;
  log?.('正在重建检索索引…');
  db.transaction(() => {
    reindexAll(db);
    markSearchIndexCurrent(db);
  })();
  return true;
}
