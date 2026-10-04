/**
 * 撤销管理操作（删除或合并标签、清除或合并学科学段、删除或合并选项…）：
 * 在一个事务里确认受影响的行仍是操作刚结束时的样子，再换回操作前的样子，
 * 并对内容因此变化的题目/资料递增版本、重建检索投影。快照见 undoJournal.ts。
 */
import type { DB } from '../db/connection.js';
import { AppError } from '../errors.js';
import { recordCatalog } from '../events/changes.js';
import { makeToucher } from './touch.js';
import { canonical, readRows, tableColumns, tableMode, takeUndo, type Row, type UndoImage, type UndoTable } from './undoJournal.js';
import type { OwnerKind } from './rows.js';

/** 删除时先删引用别人的行，插入时先插被引用的行（外键）。 */
const DELETE_ORDER: UndoTable[] = ['problem_tags', 'material_tags', 'property_values', 'tags', 'dict_entries'];
const INSERT_ORDER: UndoTable[] = ['tags', 'dict_entries', 'problem_tags', 'material_tags', 'property_values'];

function currentRows(db: DB, im: UndoImage): Row[] {
  return tableMode(im.spec.table) === 'replace' ? readRows(db, im.spec) : readRows(db, im.spec, im.after.map((r) => r.id));
}

function insertRows(db: DB, table: UndoTable, rows: readonly Row[]): void {
  const cols = tableColumns(table);
  const insert = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  for (const r of rows) insert.run(...cols.map((c) => r[c]));
}

function updateRows(db: DB, table: UndoTable, rows: readonly Row[]): void {
  const cols = tableColumns(table).filter((c) => c !== 'id');
  const update = db.prepare(`UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`);
  for (const r of rows) update.run(...cols.map((c) => r[c]), r.id);
}

/** 行里引用的题目/资料。 */
function ownersIn(table: UndoTable, r: Row): { kind: OwnerKind; id: string } | null {
  if (table === 'problem_tags' || (table === 'property_values' && r.problem_id)) return { kind: 'problem', id: r.problem_id as string };
  if (table === 'material_tags' || table === 'property_values') return { kind: 'material', id: r.material_id as string };
  if (table === 'problems') return { kind: 'problem', id: r.id as string };
  if (table === 'materials') return { kind: 'material', id: r.id as string };
  return null;
}

export function applyUndo(db: DB, id: string): { label: string; affectedItems: number } {
  const rec = takeUndo(db, id.toLowerCase());
  if (!rec) throw new AppError('NOT_FOUND', '这次操作已经不能撤销（已撤销过，或时间太久）');
  try {
    return db.transaction(() => {
      for (const part of rec.parts) recordCatalog(db, part);
      for (const im of rec.images) {
        if (canonical(currentRows(db, im)) !== canonical(im.after)) {
          throw new AppError('CONFLICT', `“${rec.label}”之后这些数据又有改动，不能撤销`);
        }
      }
      const byTable = new Map(rec.images.map((im) => [im.spec.table, im]));
      for (const t of DELETE_ORDER) {
        const im = byTable.get(t);
        if (im) db.prepare(`DELETE FROM ${t} WHERE ${im.spec.where}`).run(...im.spec.params);
      }
      // 选项：先把涉及的行都标为删除，再逐行改回，避免改回途中与尚未改回的行撞上“同级不重名”
      const opts = byTable.get('property_options');
      if (opts) {
        const mark = db.prepare('UPDATE property_options SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?');
        for (const r of opts.after) mark.run('undo', r.id);
        updateRows(db, 'property_options', opts.before);
      }
      for (const t of INSERT_ORDER) {
        const im = byTable.get(t);
        if (im) insertRows(db, t, im.before);
      }
      for (const t of ['problems', 'materials', 'saved_searches'] as const) {
        const im = byTable.get(t);
        if (im) updateRows(db, t, im.before);
      }

      // 内容变了的对象递增版本：挂接/取值行有增减，或挂着的标签改了名；只是选项路径变了的只重建检索投影
      const touch = makeToucher(db);
      const tags = byTable.get('tags');
      const renamedTags = new Set<unknown>();
      if (tags) {
        const before = new Map(tags.before.map((r) => [r.id, JSON.stringify(r)]));
        const after = new Map(tags.after.map((r) => [r.id, JSON.stringify(r)]));
        for (const k of new Set([...before.keys(), ...after.keys()])) if (before.get(k) !== after.get(k)) renamedTags.add(k);
      }
      for (const im of rec.images) {
        const before = new Set(im.before.map((r) => JSON.stringify(r)));
        const after = new Set(im.after.map((r) => JSON.stringify(r)));
        for (const [rows, other] of [
          [im.before, after],
          [im.after, before],
        ] as const) {
          for (const r of rows) {
            const owner = ownersIn(im.spec.table, r);
            if (!owner) continue;
            const changed = !other.has(JSON.stringify(r)) || renamedTags.has(r.tag_id);
            if (changed) touch.add(owner, true);
            else if (im.spec.table === 'property_values') touch.add(owner, false);
          }
        }
      }
      touch.finish();
      return { label: rec.label, affectedItems: touch.bumpedCount };
    })();
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && code.startsWith('SQLITE_CONSTRAINT')) {
      throw new AppError('CONFLICT', `“${rec.label}”之后又新建了同名的标签、选项或学科学段，不能撤销`, { cause: err });
    }
    throw err;
  }
}
