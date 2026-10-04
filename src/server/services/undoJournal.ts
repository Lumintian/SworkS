/**
 * 管理操作的撤销快照：操作开始前与结束时，在同一事务里各记一份受影响行的样子（只保存在进程内存里，
 * 一段时间后丢弃）。撤销（undo.ts）时先确认这些行仍与操作刚结束时一样，再整体换回操作前的样子；
 * 期间有过别的修改就拒绝，不覆盖之后的修改。
 *
 * 这里只读写快照，不依赖其他服务（属性、标签服务都要用它，避免循环依赖）。
 */
import { randomUUID } from 'node:crypto';
import type { DB } from '../db/connection.js';
import type { CatalogPart } from '../events/types.js';

/**
 * 每张表怎样换回去：
 * - replace：按条件选出的整组行，撤销时删掉现在的、插回操作前的（挂接、取值、字典这类没有独立身份的行）；
 * - update：按主键逐行改回操作前的列值（行本身不会消失：软删除的选项、题目上的学科学段、常用检索）。
 */
const TABLES = {
  tags: { mode: 'replace', columns: ['id', 'name', 'created_at'] },
  problem_tags: { mode: 'replace', columns: ['problem_id', 'tag_id'] },
  material_tags: { mode: 'replace', columns: ['material_id', 'tag_id'] },
  dict_entries: { mode: 'replace', columns: ['kind', 'value', 'position'] },
  property_values: { mode: 'replace', columns: ['problem_id', 'material_id', 'property_id', 'option_id', 'text_value', 'number_value'] },
  property_options: { mode: 'update', columns: ['id', 'parent_id', 'label', 'position', 'updated_at', 'deleted_at'] },
  problems: { mode: 'update', columns: ['id', 'subject', 'stage'] },
  materials: { mode: 'update', columns: ['id', 'subject', 'stage'] },
  saved_searches: { mode: 'update', columns: ['id', 'query_json', 'updated_at'] },
} as const;

export type UndoTable = keyof typeof TABLES;
export type Row = Record<string, unknown>;

/** 一组受影响的行：where 只由代码拼接（值都走参数）。 */
export interface UndoSpec {
  table: UndoTable;
  where: string;
  params: readonly unknown[];
}

export interface UndoImage {
  spec: UndoSpec;
  before: Row[];
  after: Row[];
}

export interface UndoRecord {
  id: string;
  /** 显示用，例如“删除标签” */
  label: string;
  parts: CatalogPart[];
  images: UndoImage[];
  createdAt: number;
}

/** 快照保留多久、最多几份；行数太多的操作不提供撤销（避免占用过多内存）。 */
const TTL_MS = 30 * 60_000;
const MAX_RECORDS = 20;
const MAX_ROWS = 200_000;

export function tableMode(table: UndoTable): 'replace' | 'update' {
  return TABLES[table].mode;
}

export function tableColumns(table: UndoTable): readonly string[] {
  return TABLES[table].columns;
}

/** update 表的主键都是 id。 */
function byIds(db: DB, table: UndoTable, ids: readonly unknown[]): Row[] {
  if (ids.length === 0) return [];
  return db
    .prepare(`SELECT ${TABLES[table].columns.join(', ')} FROM ${table} WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`)
    .all(JSON.stringify(ids)) as Row[];
}

/** 按条件读出一组行（replace 表）或按主键读出（update 表，keys 给出时）。 */
export function readRows(db: DB, spec: UndoSpec, keys?: readonly unknown[]): Row[] {
  const { columns } = TABLES[spec.table];
  if (keys) return byIds(db, spec.table, keys);
  return db.prepare(`SELECT ${columns.join(', ')} FROM ${spec.table} WHERE ${spec.where}`).all(...spec.params) as Row[];
}

/** 一组行的规范形式（与顺序无关），用于比较。 */
export function canonical(rows: readonly Row[]): string {
  return JSON.stringify(rows.map((r) => JSON.stringify(r)).sort());
}

const stores = new WeakMap<DB, Map<string, UndoRecord>>();

function storeOf(db: DB): Map<string, UndoRecord> {
  let s = stores.get(db);
  if (!s) stores.set(db, (s = new Map()));
  const now = Date.now();
  for (const [id, r] of s) if (now - r.createdAt > TTL_MS) s.delete(id);
  return s;
}

export interface UndoCapture {
  /** 记下操作结束时的样子并保存快照；没有任何变化或行数过多时不保存，返回 undefined */
  end(): string | undefined;
}

/** 在操作的事务里、改动之前调用。 */
export function beginUndo(db: DB, label: string, parts: CatalogPart[], specs: readonly UndoSpec[]): UndoCapture {
  const before = specs.map((spec) => ({ spec, rows: readRows(db, spec) }));
  return {
    end() {
      let total = 0;
      let changed = false;
      const images: UndoImage[] = [];
      for (const { spec, rows } of before) {
        if (tableMode(spec.table) === 'replace') {
          // 没变的也留着：撤销时整组删掉再插回（例如标签改名时挂接行不变，但要先删挂接才能换回标签行）
          const after = readRows(db, spec);
          if (canonical(after) !== canonical(rows)) changed = true;
          images.push({ spec, before: rows, after });
          total += rows.length + after.length;
        } else {
          // 只留下真正改了的行；之后按主键比较、改回
          const after = new Map(readRows(db, spec, rows.map((r) => r.id)).map((r) => [r.id, r]));
          const diff = rows.filter((r) => JSON.stringify(r) !== JSON.stringify(after.get(r.id)));
          if (diff.length) {
            changed = true;
            images.push({ spec, before: diff, after: diff.map((r) => after.get(r.id)!) });
          }
          total += diff.length * 2;
        }
      }
      if (!changed || total > MAX_ROWS) return undefined;
      const store = storeOf(db);
      const id = randomUUID();
      store.set(id, { id, label, parts, images, createdAt: Date.now() });
      while (store.size > MAX_RECORDS) store.delete(store.keys().next().value!);
      return id;
    },
  };
}

/** 取出快照（取出即作废：同一次操作只能撤销一次）。 */
export function takeUndo(db: DB, id: string): UndoRecord | undefined {
  const store = storeOf(db);
  const r = store.get(id);
  store.delete(id);
  return r;
}
