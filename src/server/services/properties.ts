/**
 * 自定义属性（参照 Obsidian 属性 / Notion 字段）：属性定义、选项（可成树，例如考点树）与取值。
 *
 * 约定：
 * - 选项按 ID 保存，改名、移动选项只需重建检索投影，不改变题目/资料的内容版本。
 * - 删除、合并选项会改变对象的取值：递增受影响对象的 write_version 并重建检索投影。
 * - 已归档的属性取值冻结保留，但不出现在返回数据、保存比较、导航与检索中。
 * - 属性不再适用于某类对象时，该类对象上的取值同样冻结。
 */
import { recordCatalog } from '../events/changes.js';
import { randomUUID } from 'node:crypto';
import type { OutlineImportResultDTO, PropertyDefDTO, PropertyOptionDTO, PropertyValueDTO, PropertyValueInput, UsageDTO } from '../../shared/api.js';
import { PROPERTY_PRESETS, RESERVED_PROPERTY_NAMES, type PropertyPreset, type PropertyType } from '../../shared/constants.js';
import { nowIso, type DB } from '../db/connection.js';
import { AppError } from '../errors.js';
import { ownerColumn, placeholders, type Owner, type OwnerKind } from './rows.js';
import type { Toucher } from './touch.js';
import { beginUndo, type UndoSpec } from './undoJournal.js';

// ---------------------------------------------------------------- 行类型

interface DefRow {
  id: string;
  name: string;
  type: PropertyType;
  nested: 0 | 1;
  applies_problem: 0 | 1;
  applies_material: 0 | 1;
  preset: string | null;
  position: number;
  show_in_nav: 0 | 1;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

interface OptionRow {
  id: string;
  property_id: string;
  parent_id: string | null;
  label: string;
  position: number;
  deleted_at: string | null;
}

interface ValueRow {
  rowid: number;
  problem_id: string | null;
  material_id: string | null;
  property_id: string;
  option_id: string | null;
  text_value: string | null;
  number_value: number | null;
}

const OPTION_TYPES: readonly PropertyType[] = ['select', 'multiselect'];

function appliesTo(def: DefRow, kind: OwnerKind): boolean {
  return kind === 'problem' ? def.applies_problem === 1 : def.applies_material === 1;
}

function getDef(db: DB, id: string): DefRow {
  const d = db.prepare('SELECT * FROM property_defs WHERE id = ?').get(id) as DefRow | undefined;
  if (!d) throw new AppError('NOT_FOUND', '属性不存在');
  return d;
}

function getOption(db: DB, id: string): OptionRow {
  const o = db.prepare('SELECT * FROM property_options WHERE id = ?').get(id) as OptionRow | undefined;
  if (!o || o.deleted_at) throw new AppError('NOT_FOUND', '选项不存在');
  return o;
}

/** 参与保存比较、检索与导航的属性：未归档且适用于这类对象。 */
function managedDefs(db: DB, kind: OwnerKind): DefRow[] {
  return (db.prepare('SELECT * FROM property_defs WHERE archived_at IS NULL ORDER BY position, created_at, id').all() as DefRow[]).filter((d) =>
    appliesTo(d, kind),
  );
}

// ---------------------------------------------------------------- 选项树

interface OptionTree {
  ordered: PropertyOptionDTO[];
  byId: Map<string, PropertyOptionDTO>;
  children: Map<string | null, string[]>;
}

function buildOptionTree(rows: OptionRow[]): OptionTree {
  const children = new Map<string | null, OptionRow[]>();
  for (const r of rows) {
    const list = children.get(r.parent_id) ?? [];
    list.push(r);
    children.set(r.parent_id, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.position - b.position || a.label.localeCompare(b.label, 'zh-Hans-CN'));
  const ordered: PropertyOptionDTO[] = [];
  const byId = new Map<string, PropertyOptionDTO>();
  const walk = (parent: string | null, prefix: string, depth: number) => {
    for (const r of children.get(parent) ?? []) {
      const dto: PropertyOptionDTO = { id: r.id, parentId: r.parent_id, label: r.label, path: prefix ? `${prefix}/${r.label}` : r.label, position: r.position, depth };
      ordered.push(dto);
      byId.set(r.id, dto);
      walk(r.id, dto.path, depth + 1);
    }
  };
  walk(null, '', 0);
  return {
    ordered,
    byId,
    children: new Map([...children].map(([k, v]) => [k, v.map((r) => r.id)])),
  };
}

function liveOptionRows(db: DB, propertyId: string): OptionRow[] {
  return db.prepare('SELECT * FROM property_options WHERE property_id = ? AND deleted_at IS NULL').all(propertyId) as OptionRow[];
}

function optionTreeOf(db: DB, propertyId: string): OptionTree {
  return buildOptionTree(liveOptionRows(db, propertyId));
}

/** 选项及其全部后代的 ID。 */
export function optionSubtree(tree: OptionTree, id: string): string[] {
  const out: string[] = [];
  const walk = (x: string) => {
    out.push(x);
    for (const c of tree.children.get(x) ?? []) walk(c);
  };
  walk(id);
  return out;
}

/**
 * 全部未删除选项的完整路径与树内顺序（用于检索投影与列表显示）。
 * 一次读出、多次使用：列表一页、重建全部检索投影时共用一份，不必每个对象都重读选项树。
 */
export interface OptionIndex {
  paths: Map<string, string>;
  /** 选项在所属属性的深度优先顺序中的位置 */
  order: Map<string, number>;
}

export function optionIndex(db: DB): OptionIndex {
  const rows = db.prepare('SELECT * FROM property_options WHERE deleted_at IS NULL').all() as OptionRow[];
  const byProp = new Map<string, OptionRow[]>();
  for (const r of rows) {
    const list = byProp.get(r.property_id) ?? [];
    list.push(r);
    byProp.set(r.property_id, list);
  }
  const paths = new Map<string, string>();
  const order = new Map<string, number>();
  for (const list of byProp.values()) {
    buildOptionTree(list).ordered.forEach((o, i) => {
      paths.set(o.id, o.path);
      order.set(o.id, i);
    });
  }
  return { paths, order };
}

function toDefDTO(d: DefRow, options: PropertyOptionDTO[]): PropertyDefDTO {
  return {
    id: d.id,
    name: d.name,
    type: d.type,
    nested: d.nested === 1,
    appliesProblem: d.applies_problem === 1,
    appliesMaterial: d.applies_material === 1,
    preset: PROPERTY_PRESETS.includes(d.preset as PropertyPreset) ? (d.preset as PropertyPreset) : null,
    position: d.position,
    showInNav: d.show_in_nav === 1,
    archived: d.archived_at !== null,
    options: OPTION_TYPES.includes(d.type) ? options : [],
  };
}

export function listPropertyDefs(db: DB, opts: { includeArchived?: boolean } = {}): PropertyDefDTO[] {
  const defs = db.prepare('SELECT * FROM property_defs ORDER BY archived_at IS NOT NULL, position, created_at, id').all() as DefRow[];
  return defs.filter((d) => opts.includeArchived || d.archived_at === null).map((d) => toDefDTO(d, optionTreeOf(db, d.id).ordered));
}

export function getPropertyDef(db: DB, id: string): PropertyDefDTO {
  const d = getDef(db, id);
  return toDefDTO(d, optionTreeOf(db, id).ordered);
}

// ---------------------------------------------------------------- 取值：读取

function ownerValueRows(db: DB, owner: Owner): ValueRow[] {
  return db.prepare(`SELECT rowid, * FROM property_values WHERE ${ownerColumn(owner.kind)} = ?`).all(owner.id) as ValueRow[];
}

function formatNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

/** 对象上（受管理属性的）取值，按属性顺序；多选的选项按树的顺序。 */
export function loadPropertyValues(db: DB, owner: Owner, idx?: OptionIndex): PropertyValueDTO[] {
  const rows = ownerValueRows(db, owner);
  if (rows.length === 0) return [];
  const out: PropertyValueDTO[] = [];
  for (const d of managedDefs(db, owner.kind)) {
    const mine = rows.filter((r) => r.property_id === d.id);
    if (mine.length === 0) continue;
    if (OPTION_TYPES.includes(d.type)) {
      const order = idx?.order ?? new Map(optionTreeOf(db, d.id).ordered.map((o, i) => [o.id, i]));
      const ids = mine
        .map((r) => r.option_id!)
        .filter((id) => order.has(id))
        .sort((a, b) => order.get(a)! - order.get(b)!);
      if (ids.length) out.push({ propertyId: d.id, optionIds: ids });
    } else if (d.type === 'text') out.push({ propertyId: d.id, text: mine[0]!.text_value! });
    else if (d.type === 'date') out.push({ propertyId: d.id, date: mine[0]!.text_value! });
    else if (d.type === 'number') out.push({ propertyId: d.id, number: mine[0]!.number_value! });
    else if (d.type === 'checkbox') out.push({ propertyId: d.id, checked: true });
  }
  return out;
}

/** 列表与导出用的显示文字：选项为完整路径，勾选为“是”。 */
export function propertyDisplay(db: DB, owner: Owner, idx?: OptionIndex): { propertyId: string; name: string; type: PropertyType; values: string[] }[] {
  const i = idx ?? optionIndex(db);
  const values = loadPropertyValues(db, owner, i);
  if (values.length === 0) return [];
  const defs = new Map(managedDefs(db, owner.kind).map((d) => [d.id, d]));
  const p = i.paths;
  return values.map((v) => {
    const d = defs.get(v.propertyId)!;
    let shown: string[];
    if (v.optionIds) shown = v.optionIds.map((id) => p.get(id) ?? '');
    else if (v.text !== undefined) shown = [v.text];
    else if (v.date !== undefined) shown = [v.date];
    else if (v.number !== undefined) shown = [formatNumber(v.number)];
    else shown = ['是'];
    return { propertyId: v.propertyId, name: d.name, type: d.type, values: shown.filter(Boolean) };
  });
}

/** 检索投影中的属性文本。 */
export function propertyIndexTexts(db: DB, owner: Owner, idx?: OptionIndex): string[] {
  return propertyDisplay(db, owner, idx)
    .filter((p) => p.type !== 'checkbox')
    .flatMap((p) => p.values);
}

// ---------------------------------------------------------------- 取值：写入

interface WantedValue {
  property_id: string;
  option_id: string | null;
  text_value: string | null;
  number_value: number | null;
}

function valueKey(v: WantedValue): string {
  if (v.option_id) return `${v.property_id}|o|${v.option_id}`;
  if (v.text_value !== null) return `${v.property_id}|t|${v.text_value}`;
  return `${v.property_id}|n|${v.number_value}`;
}

/** 校验一个属性的输入并展开成要保存的行；返回空数组表示清空。 */
function normalizeValue(db: DB, def: DefRow, v: PropertyValueInput, options?: OptionTree): WantedValue[] {
  const base = { property_id: def.id, option_id: null, text_value: null, number_value: null };
  const only = (field: keyof PropertyValueInput) => {
    for (const k of ['optionIds', 'text', 'number', 'date', 'checked'] as const) {
      if (k !== field && v[k] !== undefined) throw new AppError('VALIDATION', `属性“${def.name}”的取值类型不符`);
    }
  };
  switch (def.type) {
    case 'select':
    case 'multiselect': {
      only('optionIds');
      const ids = [...new Set((v.optionIds ?? []).map((x) => x.toLowerCase()))];
      if (def.type === 'select' && ids.length > 1) throw new AppError('VALIDATION', `属性“${def.name}”只能选一个`);
      const tree = options ?? optionTreeOf(db, def.id);
      for (const id of ids) if (!tree.byId.has(id)) throw new AppError('VALIDATION', `属性“${def.name}”的选项不存在或已删除`);
      return ids.map((id) => ({ ...base, option_id: id }));
    }
    case 'text': {
      only('text');
      const t = v.text?.trim();
      return t ? [{ ...base, text_value: t }] : [];
    }
    case 'date':
      only('date');
      if (v.date !== undefined && Number.isNaN(Date.parse(`${v.date}T00:00:00Z`))) throw new AppError('VALIDATION', `属性“${def.name}”的日期无效`);
      return v.date ? [{ ...base, text_value: v.date }] : [];
    case 'number':
      only('number');
      return v.number !== undefined ? [{ ...base, number_value: v.number }] : [];
    case 'checkbox':
      only('checked');
      return v.checked ? [{ ...base, number_value: 1 }] : [];
  }
}

/** 按差异写入：删除不再需要的行、插入新的行。返回是否有变化。 */
function applyValueDiff(db: DB, owner: Owner, current: ValueRow[], wanted: WantedValue[]): boolean {
  const col = ownerColumn(owner.kind);
  const wantKeys = new Map(wanted.map((w) => [valueKey(w), w]));
  const haveKeys = new Map(current.map((r) => [valueKey(r), r]));
  let changed = false;
  const del = db.prepare('DELETE FROM property_values WHERE rowid = ?');
  for (const [k, r] of haveKeys) {
    if (!wantKeys.has(k)) {
      del.run(r.rowid);
      changed = true;
    }
  }
  const insert = db.prepare(
    `INSERT INTO property_values (${col}, property_id, option_id, text_value, number_value) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const [k, w] of wantKeys) {
    if (!haveKeys.has(k)) {
      insert.run(owner.id, w.property_id, w.option_id, w.text_value, w.number_value);
      changed = true;
    }
  }
  return changed;
}

/**
 * 保存对象的属性。input 为 undefined 时不改动；否则 input 就是全部受管理属性的完整取值，
 * 没有出现的属性视为清空。已归档或不适用的属性取值保持不变。返回是否有变化。
 */
export function writeProperties(db: DB, owner: Owner, input: PropertyValueInput[] | undefined): boolean {
  if (input === undefined) return false;
  const defs = new Map(managedDefs(db, owner.kind).map((d) => [d.id, d]));
  const seen = new Set<string>();
  const wanted: WantedValue[] = [];
  for (const v of input) {
    const pid = v.propertyId.toLowerCase();
    if (seen.has(pid)) throw new AppError('VALIDATION', '属性取值重复');
    seen.add(pid);
    const def = defs.get(pid);
    if (!def) {
      // 已归档或不适用的属性：取值冻结，忽略这次提交的值（例如编辑期间属性被归档）
      if (db.prepare('SELECT 1 FROM property_defs WHERE id = ?').get(pid)) continue;
      throw new AppError('VALIDATION', '属性不存在');
    }
    wanted.push(...normalizeValue(db, def, { ...v, propertyId: pid }));
  }
  const current = ownerValueRows(db, owner).filter((r) => defs.has(r.property_id));
  return applyValueDiff(db, owner, current, wanted);
}

/** 从资料建题：复制同时适用于题目的属性取值。 */
export function copyProperties(db: DB, from: Owner, to: Owner): void {
  const targetDefs = new Set(managedDefs(db, to.kind).map((d) => d.id));
  const values = loadPropertyValues(db, from).filter((v) => targetDefs.has(v.propertyId));
  if (values.length) writeProperties(db, to, values);
}

/** 批量操作：设置某个属性（替换原值）、追加或移除多选项。返回是否有变化。 */
export function applyPropertyOp(
  db: DB,
  owner: Owner,
  op: { kind: 'set'; propertyId: string; value: PropertyValueInput | null } | { kind: 'add' | 'remove'; propertyId: string; optionIds: string[] },
): boolean {
  const def = getDef(db, op.propertyId.toLowerCase());
  if (def.archived_at || !appliesTo(def, owner.kind)) throw new AppError('VALIDATION', `属性“${def.name}”已归档或不适用于这类对象`);
  const current = ownerValueRows(db, owner).filter((r) => r.property_id === def.id);
  let wanted: WantedValue[];
  if (op.kind === 'set') {
    wanted = op.value ? normalizeValue(db, def, { ...op.value, propertyId: def.id }) : [];
  } else {
    if (def.type !== 'multiselect') throw new AppError('VALIDATION', `属性“${def.name}”不是多选属性`);
    const tree = optionTreeOf(db, def.id);
    const ids = new Set(current.map((r) => r.option_id!));
    for (const raw of op.optionIds) {
      const id = raw.toLowerCase();
      if (!tree.byId.has(id)) throw new AppError('VALIDATION', `属性“${def.name}”的选项不存在或已删除`);
      if (op.kind === 'add') ids.add(id);
      else ids.delete(id);
    }
    wanted = normalizeValue(db, def, { propertyId: def.id, optionIds: [...ids] }, tree);
  }
  return applyValueDiff(db, owner, current, wanted);
}

// ---------------------------------------------------------------- 影响范围

/** 取值用到了这些选项的对象。 */
function ownersOfOptions(db: DB, optionIds: readonly string[]): Owner[] {
  if (optionIds.length === 0) return [];
  const rows = db
    .prepare(`SELECT DISTINCT problem_id, material_id FROM property_values WHERE option_id IN (${placeholders(optionIds.length)})`)
    .all(...optionIds) as { problem_id: string | null; material_id: string | null }[];
  return rows.map((r) => (r.problem_id ? { kind: 'problem', id: r.problem_id } : { kind: 'material', id: r.material_id! }));
}

function ownersOfProperty(db: DB, propertyId: string): Owner[] {
  const rows = db.prepare('SELECT DISTINCT problem_id, material_id FROM property_values WHERE property_id = ?').all(propertyId) as {
    problem_id: string | null;
    material_id: string | null;
  }[];
  return rows.map((r) => (r.problem_id ? { kind: 'problem', id: r.problem_id } : { kind: 'material', id: r.material_id! }));
}

/**
 * 管理操作的收尾由调用方提供（touch.ts#makeToucher）：收集受影响的对象，事务结束前 finish() 统一
 * 递增版本（按需）、重建检索投影。由调用方传入是为了避免与 entities/search 形成循环依赖。
 */
export type { Toucher } from './touch.js';

/**
 * 数据管理：每个选项（含子树）下不重复的对象数，回收站中的对象单独计数。
 * 冻结的取值（属性不再适用于这类对象）也算在内：删除、合并选项同样作用于它们。
 */
export function optionUsage(db: DB, propertyId: string): Record<string, UsageDTO> {
  const d = requireOptionDef(db, propertyId);
  const parentOf = new Map(optionTreeOf(db, d.id).ordered.map((o) => [o.id, o.parentId]));
  const rows = db
    .prepare(
      `SELECT v.option_id, v.problem_id, v.material_id, COALESCE(p.deleted_at, m.deleted_at) AS deleted_at
       FROM property_values v LEFT JOIN problems p ON p.id = v.problem_id LEFT JOIN materials m ON m.id = v.material_id
       WHERE v.property_id = ? AND v.option_id IS NOT NULL`,
    )
    .all(d.id) as { option_id: string; problem_id: string | null; material_id: string | null; deleted_at: string | null }[];
  const sets = new Map<string, { problems: Set<string>; materials: Set<string>; trashed: Set<string> }>();
  for (const r of rows) {
    for (let cur: string | null | undefined = r.option_id; cur; cur = parentOf.get(cur)) {
      let s = sets.get(cur);
      if (!s) sets.set(cur, (s = { problems: new Set(), materials: new Set(), trashed: new Set() }));
      if (r.deleted_at) s.trashed.add(r.problem_id ? `p:${r.problem_id}` : `m:${r.material_id}`);
      else if (r.problem_id) s.problems.add(r.problem_id);
      else s.materials.add(r.material_id!);
    }
  }
  const out: Record<string, UsageDTO> = {};
  for (const [id, s] of sets) out[id] = { problems: s.problems.size, materials: s.materials.size, trashed: s.trashed.size };
  return out;
}

// ---------------------------------------------------------------- 属性定义管理

function validateName(db: DB, name: string, exceptId?: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n || n.length > 40) throw new AppError('VALIDATION', '属性名称应为 1–40 个字');
  if (RESERVED_PROPERTY_NAMES.some((r) => r.toLowerCase() === n.toLowerCase())) throw new AppError('VALIDATION', `“${n}”是内置字段名，请换一个名称`);
  const clash = (db.prepare('SELECT id, name FROM property_defs WHERE archived_at IS NULL').all() as { id: string; name: string }[]).find(
    (d) => d.id !== exceptId && d.name.toLowerCase() === n.toLowerCase(),
  );
  if (clash) throw new AppError('CONFLICT', `已有名为“${clash.name}”的属性`);
  return n;
}

export function createPropertyDef(
  db: DB,
  input: { id: string; name: string; type: PropertyType; nested: boolean; appliesProblem: boolean; appliesMaterial: boolean },
): PropertyDefDTO {
  const id = input.id.toLowerCase();
  return db.transaction(() => {
    recordCatalog(db, 'properties');
    if (db.prepare('SELECT 1 FROM property_defs WHERE id = ?').get(id)) return getPropertyDef(db, id);
    const name = validateName(db, input.name);
    if (input.nested && !OPTION_TYPES.includes(input.type)) throw new AppError('VALIDATION', '只有单选、多选属性的选项可以分层');
    if (!input.appliesProblem && !input.appliesMaterial) throw new AppError('VALIDATION', '属性至少要适用于题目或资料之一');
    const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM property_defs').get() as { m: number };
    const now = nowIso();
    db.prepare(
      `INSERT INTO property_defs (id, name, type, nested, applies_problem, applies_material, preset, position, show_in_nav, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    ).run(id, name, input.type, input.nested ? 1 : 0, input.appliesProblem ? 1 : 0, input.appliesMaterial ? 1 : 0, max.m + 1, OPTION_TYPES.includes(input.type) || input.type === 'checkbox' ? 1 : 0, now, now);
    return getPropertyDef(db, id);
  })();
}

export function updatePropertyDef(
  db: DB,
  id: string,
  input: {
    name?: string | undefined;
    showInNav?: boolean | undefined;
    appliesProblem?: boolean | undefined;
    appliesMaterial?: boolean | undefined;
    nested?: boolean | undefined;
  },
  touch: Toucher,
): PropertyDefDTO {
  return db.transaction(() => {
    recordCatalog(db, 'properties');
    const d = getDef(db, id);
    const name = input.name !== undefined ? validateName(db, input.name, d.id) : d.name;
    const ap = input.appliesProblem ?? d.applies_problem === 1;
    const am = input.appliesMaterial ?? d.applies_material === 1;
    if (!ap && !am) throw new AppError('VALIDATION', '属性至少要适用于题目或资料之一');
    const showInNav = input.showInNav ?? d.show_in_nav === 1;
    // 选项分层：平 → 分层随时可以（选项都在顶层，路径不变）；分层 → 平要求没有下级选项。取值与路径都不变，无需递增版本。
    const nested = input.nested ?? d.nested === 1;
    if (nested !== (d.nested === 1)) {
      if (!OPTION_TYPES.includes(d.type)) throw new AppError('VALIDATION', '只有单选、多选属性的选项可以分层');
      if (!nested && db.prepare('SELECT 1 FROM property_options WHERE property_id = ? AND parent_id IS NOT NULL AND deleted_at IS NULL LIMIT 1').get(d.id)) {
        throw new AppError('VALIDATION', `“${d.name}”还有下级选项，请先把它们移到顶级或合并，再取消分层`);
      }
    }
    db.prepare('UPDATE property_defs SET name = ?, applies_problem = ?, applies_material = ?, show_in_nav = ?, nested = ?, updated_at = ? WHERE id = ?').run(
      name,
      ap ? 1 : 0,
      am ? 1 : 0,
      showInNav ? 1 : 0,
      nested ? 1 : 0,
      nowIso(),
      d.id,
    );
    // 适用范围变化会让部分取值冻结或恢复：只重建检索投影，内容版本不变
    if (ap !== (d.applies_problem === 1) || am !== (d.applies_material === 1)) for (const o of ownersOfProperty(db, d.id)) touch.add(o, false);
    touch.finish();
    return getPropertyDef(db, d.id);
  })();
}

/** 归档（或取消归档）属性：取值冻结保留，不出现在编辑页、导航与检索中。预置属性不能归档，只能隐藏。 */
export function setPropertyArchived(db: DB, id: string, archived: boolean, touch: Toucher): PropertyDefDTO {
  return db.transaction(() => {
    recordCatalog(db, 'properties');
    const d = getDef(db, id);
    if (archived && d.preset) throw new AppError('VALIDATION', '预置属性不能归档，可以在导航中隐藏');
    if ((d.archived_at !== null) === archived) return getPropertyDef(db, d.id);
    if (!archived) validateName(db, d.name, d.id);
    db.prepare('UPDATE property_defs SET archived_at = ?, updated_at = ? WHERE id = ?').run(archived ? nowIso() : null, nowIso(), d.id);
    for (const o of ownersOfProperty(db, d.id)) touch.add(o, false);
    touch.finish();
    return getPropertyDef(db, d.id);
  })();
}

export function reorderPropertyDefs(db: DB, ids: readonly string[]): void {
  db.transaction(() => {
    recordCatalog(db, 'properties');
    const all = (db.prepare('SELECT id FROM property_defs ORDER BY position, created_at, id').all() as { id: string }[]).map((r) => r.id);
    const wanted = ids.map((i) => i.toLowerCase()).filter((i) => all.includes(i));
    const order = [...new Set(wanted), ...all.filter((i) => !wanted.includes(i))];
    const set = db.prepare('UPDATE property_defs SET position = ? WHERE id = ?');
    order.forEach((id, i) => set.run(i, id));
  })();
}

// ---------------------------------------------------------------- 选项管理

function requireOptionDef(db: DB, propertyId: string): DefRow {
  const d = getDef(db, propertyId);
  if (!OPTION_TYPES.includes(d.type)) throw new AppError('VALIDATION', `属性“${d.name}”没有选项`);
  return d;
}

function normalizeLabel(raw: string): string {
  // “/”用于表示层级路径，选项名里改用全角斜杠
  const l = raw.replace(/\s+/g, ' ').trim().replace(/\//g, '／');
  if (!l || l.length > 60) throw new AppError('VALIDATION', '选项名称应为 1–60 个字');
  return l;
}

function siblingByLabel(db: DB, propertyId: string, parentId: string | null, label: string, exceptId?: string): OptionRow | undefined {
  return (
    db.prepare('SELECT * FROM property_options WHERE property_id = ? AND parent_id IS ? AND deleted_at IS NULL').all(propertyId, parentId) as OptionRow[]
  ).find((o) => o.id !== exceptId && o.label.toLowerCase() === label.toLowerCase());
}

function nextPosition(db: DB, propertyId: string, parentId: string | null): number {
  return (
    db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM property_options WHERE property_id = ? AND parent_id IS ? AND deleted_at IS NULL').get(propertyId, parentId) as {
      m: number;
    }
  ).m + 1;
}

function insertOption(db: DB, id: string, propertyId: string, parentId: string | null, label: string): string {
  const now = nowIso();
  db.prepare('INSERT INTO property_options (id, property_id, parent_id, label, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id,
    propertyId,
    parentId,
    label,
    nextPosition(db, propertyId, parentId),
    now,
    now,
  );
  return id;
}

export function createOption(db: DB, propertyId: string, input: { id: string; label: string; parentId: string | null }): PropertyDefDTO {
  return db.transaction(() => {
    recordCatalog(db, 'properties');
    const d = requireOptionDef(db, propertyId);
    const id = input.id.toLowerCase();
    if (db.prepare('SELECT 1 FROM property_options WHERE id = ?').get(id)) return getPropertyDef(db, d.id);
    const parentId = input.parentId?.toLowerCase() ?? null;
    if (parentId) {
      if (!d.nested) throw new AppError('VALIDATION', `属性“${d.name}”的选项不分层`);
      if (getOption(db, parentId).property_id !== d.id) throw new AppError('VALIDATION', '上级选项不属于这个属性');
    }
    const label = normalizeLabel(input.label);
    if (siblingByLabel(db, d.id, parentId, label)) throw new AppError('CONFLICT', `同一层级下已有“${label}”`);
    insertOption(db, id, d.id, parentId, label);
    return getPropertyDef(db, d.id);
  })();
}

/** 按路径（用 / 分隔）找到选项，不存在的层级自动创建；返回最后一级的 ID。 */
export function ensureOptionPath(db: DB, propertyId: string, path: string): string {
  return db.transaction(() => {
    recordCatalog(db, 'properties');
    const d = requireOptionDef(db, propertyId);
    const segs = path
      .split('/')
      .map((s) => s.trim())
      .filter(Boolean);
    if (segs.length === 0) throw new AppError('VALIDATION', '选项名称不能为空');
    if (!d.nested && segs.length > 1) throw new AppError('VALIDATION', `属性“${d.name}”的选项不分层`);
    let parent: string | null = null;
    for (const seg of segs) {
      const label = normalizeLabel(seg);
      const found = siblingByLabel(db, d.id, parent, label);
      parent = found ? found.id : insertOption(db, randomUUID(), d.id, parent, label);
    }
    return parent!;
  })();
}

export function renameOption(db: DB, optionId: string, rawLabel: string, touch: Toucher): PropertyDefDTO {
  return db.transaction(() => {
    recordCatalog(db, 'properties');
    const o = getOption(db, optionId);
    const label = normalizeLabel(rawLabel);
    if (label === o.label) return getPropertyDef(db, o.property_id);
    if (siblingByLabel(db, o.property_id, o.parent_id, label, o.id)) throw new AppError('CONFLICT', `同一层级下已有“${label}”，可以改用合并`);
    db.prepare('UPDATE property_options SET label = ?, updated_at = ? WHERE id = ?').run(label, nowIso(), o.id);
    // 选项按 ID 保存：只需重建子树内取值对象的检索投影
    for (const owner of ownersOfOptions(db, optionSubtree(optionTreeOf(db, o.property_id), o.id))) touch.add(owner, false);
    touch.finish();
    return getPropertyDef(db, o.property_id);
  })();
}

export function moveOption(db: DB, optionId: string, parentIdRaw: string | null, index: number | undefined, touch: Toucher): PropertyDefDTO {
  return moveOptions(db, [optionId], parentIdRaw, index, touch);
}

/**
 * 把多个选项（同一属性）移到 parent 下的 index 位置，保持它们给定的相对顺序；
 * 被其他所选项包含的后代跟着上级一起走，不单独移动。index 按“去掉这些选项后”的同级列表计算，省略表示放到最后。
 * 选项按 ID 保存，移动只重建检索投影（路径变了），不递增版本。
 */
export function moveOptions(db: DB, optionIds: readonly string[], parentIdRaw: string | null, index: number | undefined, touch: Toucher): PropertyDefDTO {
  return db.transaction(() => {
    recordCatalog(db, 'properties');
    const opts = [...new Set(optionIds.map((x) => x.toLowerCase()))].map((id) => getOption(db, id));
    if (opts.length === 0) throw new AppError('VALIDATION', '没有要移动的选项');
    const d = getDef(db, opts[0]!.property_id);
    if (opts.some((o) => o.property_id !== d.id)) throw new AppError('VALIDATION', '只能一起移动同一属性的选项');
    const tree = optionTreeOf(db, d.id);
    // 只保留最上层：某个选项的上级也被选中时，它随上级移动
    const selected = new Set(opts.map((o) => o.id));
    const hasSelectedAncestor = (o: OptionRow) => {
      for (let p = o.parent_id; p; p = tree.byId.get(p)?.parentId ?? null) if (selected.has(p)) return true;
      return false;
    };
    const moving = opts.filter((o) => !hasSelectedAncestor(o));
    const parentId = parentIdRaw?.toLowerCase() ?? null;
    if (parentId) {
      if (!d.nested) throw new AppError('VALIDATION', `属性“${d.name}”的选项不分层`);
      const p = getOption(db, parentId);
      if (p.property_id !== d.id) throw new AppError('VALIDATION', '上级选项不属于这个属性');
      if (moving.some((o) => optionSubtree(tree, o.id).includes(parentId))) throw new AppError('VALIDATION', '不能把选项移动到它自己的下级');
    }
    const labels = new Set<string>();
    for (const o of moving) {
      const k = o.label.toLowerCase();
      if (labels.has(k)) throw new AppError('CONFLICT', `所选选项中有同名的“${o.label}”，不能放到同一层级，可以改用合并`);
      labels.add(k);
      if (parentId !== o.parent_id && siblingByLabel(db, d.id, parentId, o.label, o.id)) throw new AppError('CONFLICT', `目标位置已有“${o.label}”，可以改用合并`);
    }
    const movingIds = new Set(moving.map((o) => o.id));
    const siblings = (tree.children.get(parentId) ?? []).filter((x) => !movingIds.has(x));
    const at = index === undefined ? siblings.length : Math.min(index, siblings.length);
    siblings.splice(at, 0, ...moving.map((o) => o.id));
    const now = nowIso();
    const setParent = db.prepare('UPDATE property_options SET parent_id = ?, updated_at = ? WHERE id = ?');
    for (const o of moving) if (o.parent_id !== parentId) setParent.run(parentId, now, o.id);
    const setPos = db.prepare('UPDATE property_options SET position = ? WHERE id = ?');
    siblings.forEach((id, i) => setPos.run(i, id));
    for (const o of moving) {
      if (parentId !== o.parent_id) for (const owner of ownersOfOptions(db, optionSubtree(tree, o.id))) touch.add(owner, false);
    }
    touch.finish();
    return getPropertyDef(db, d.id);
  })();
}

/** 撤销快照：这些选项行、用到它们的取值，以及常用检索（合并时会改写）。 */
function optionUndoSpecs(ids: readonly string[]): UndoSpec[] {
  const p = [JSON.stringify(ids)];
  return [
    { table: 'property_options', where: 'id IN (SELECT value FROM json_each(?))', params: p },
    { table: 'property_values', where: 'option_id IN (SELECT value FROM json_each(?))', params: p },
    { table: 'saved_searches', where: 'deleted_at IS NULL', params: [] },
  ];
}

/** 删除选项（含子树）：选项软删除，对象上的这些取值移除（递增版本）。 */
export function deleteOption(db: DB, optionId: string, touch: Toucher): { deleted: number; affectedItems: number; undoId?: string | undefined } {
  return deleteOptions(db, [optionId], touch);
}

/** 一次删除多个选项（各含子树，可跨属性）：子树取并集，一个事务，每个对象只递增一次版本。 */
export function deleteOptions(db: DB, optionIds: readonly string[], touch: Toucher): { deleted: number; affectedItems: number; undoId?: string | undefined } {
  return db.transaction(() => {
    recordCatalog(db, 'properties');
    const ids = new Set<string>();
    const trees = new Map<string, OptionTree>();
    for (const raw of new Set(optionIds.map((x) => x.toLowerCase()))) {
      if (ids.has(raw)) continue; // 已在某个所选上级的子树里
      const o = getOption(db, raw);
      let tree = trees.get(o.property_id);
      if (!tree) {
        tree = optionTreeOf(db, o.property_id);
        trees.set(o.property_id, tree);
      }
      for (const id of optionSubtree(tree, o.id)) ids.add(id);
    }
    const list = [...ids];
    const undo = beginUndo(db, '删除选项', ['properties'], optionUndoSpecs(list));
    const owners = ownersOfOptions(db, list);
    const ph = placeholders(list.length);
    const now = nowIso();
    db.prepare(`DELETE FROM property_values WHERE option_id IN (${ph})`).run(...list);
    db.prepare(`UPDATE property_options SET deleted_at = ?, updated_at = ? WHERE id IN (${ph})`).run(now, now, ...list);
    for (const owner of owners) touch.add(owner, true);
    touch.finish();
    return { deleted: list.length, affectedItems: owners.length, undoId: undo.end() };
  })();
}

/**
 * 合并选项：source 上的取值转到 target（已有的不重复），source 的下级移到 target 下
 * （同名下级继续合并），然后软删除 source。常用检索里的 source 改指向 target。
 */
export function mergeOption(db: DB, sourceId: string, targetId: string, touch: Toucher): { affectedItems: number; undoId?: string | undefined } {
  const { affectedItems, undoId } = mergeOptions(db, [sourceId], targetId, touch);
  return { affectedItems, undoId };
}

/** 合并的实际步骤（调用方负责事务与 finish）；返回取值被改动的对象（kind:id）。 */
function mergeOptionTx(db: DB, src: OptionRow, dst: OptionRow, touch: Toucher): Set<string> {
  const bumped = new Set<string>();
  if (src.id === dst.id) return bumped;
  if (src.property_id !== dst.property_id) throw new AppError('VALIDATION', '只能合并同一属性的选项');
  const def = getDef(db, src.property_id);
  const tree = optionTreeOf(db, def.id);
  if (optionSubtree(tree, src.id).includes(dst.id)) throw new AppError('VALIDATION', '不能合并到自己的下级');
  // 子树里的选项路径会变：用到它们的对象至少要重建检索投影
  for (const o of ownersOfOptions(db, optionSubtree(tree, src.id))) touch.add(o, false);
  const now = nowIso();
  const mergeInto = (s: OptionRow, t: OptionRow) => {
    for (const kind of ['problem', 'material'] as const) {
      const col = ownerColumn(kind);
      const owners = (db.prepare(`SELECT ${col} AS id FROM property_values WHERE option_id = ? AND ${col} IS NOT NULL`).all(s.id) as { id: string }[]).map((r) => r.id);
      for (const id of owners) {
        const has = db.prepare(`SELECT 1 FROM property_values WHERE ${col} = ? AND option_id = ?`).get(id, t.id);
        if (has) db.prepare(`DELETE FROM property_values WHERE ${col} = ? AND option_id = ?`).run(id, s.id);
        else db.prepare(`UPDATE property_values SET option_id = ? WHERE ${col} = ? AND option_id = ?`).run(t.id, id, s.id);
        touch.add({ kind, id }, true);
        bumped.add(`${kind}:${id}`);
      }
    }
    for (const child of db.prepare('SELECT * FROM property_options WHERE parent_id = ? AND deleted_at IS NULL').all(s.id) as OptionRow[]) {
      const clash = siblingByLabel(db, def.id, t.id, child.label);
      if (clash) mergeInto(child, clash);
      else db.prepare('UPDATE property_options SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?').run(t.id, nextPosition(db, def.id, t.id), now, child.id);
    }
    db.prepare('UPDATE property_options SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, s.id);
    touch.optionMerged(s.id, t.id);
  };
  // 单选属性：同一对象不可能同时有 source 与 target，上面的更新即可
  mergeInto(src, dst);
  return bumped;
}

/**
 * 把多个选项合并到同一个目标：先整体校验（同一属性、目标不在任何源的子树内），再逐个合并；
 * 源的上级也被选中时随上级一起合并。一个事务，每个对象只递增一次版本，最后统一重建检索投影。
 */
export function mergeOptions(
  db: DB,
  sourceIds: readonly string[],
  targetId: string,
  touch: Toucher,
): { merged: number; affectedItems: number; undoId?: string | undefined } {
  return db.transaction(() => {
    recordCatalog(db, 'properties');
    const dst = getOption(db, targetId);
    const tree = optionTreeOf(db, dst.property_id);
    const srcs = [...new Set(sourceIds.map((x) => x.toLowerCase()))].filter((id) => id !== dst.id).map((id) => getOption(db, id));
    for (const s of srcs) {
      if (s.property_id !== dst.property_id) throw new AppError('VALIDATION', '只能合并同一属性的选项');
      if (optionSubtree(tree, s.id).includes(dst.id)) throw new AppError('VALIDATION', `不能把“${s.label}”合并到它自己的下级`);
    }
    const selected = new Set(srcs.map((s) => s.id));
    const topmost = srcs.filter((s) => {
      for (let p = s.parent_id; p; p = tree.byId.get(p)?.parentId ?? null) if (selected.has(p)) return false;
      return true;
    });
    const involved = new Set([dst, ...topmost].flatMap((o) => optionSubtree(tree, o.id)));
    const undo = beginUndo(db, '合并选项', ['properties', 'savedSearches'], optionUndoSpecs([...involved]));
    const affected = new Set<string>();
    for (const s of topmost) for (const k of mergeOptionTx(db, getOption(db, s.id), getOption(db, dst.id), touch)) affected.add(k);
    touch.finish();
    return { merged: topmost.length, affectedItems: affected.size, undoId: undo.end() };
  })();
}

/** 试运行时用来回滚事务的标记。 */
const DRY_RUN = Symbol('dry-run');

/**
 * 从大纲导入选项：每行一个，缩进或 Markdown 列表（- / * / + / 1.）表示层级，# 标题按级别表示层级。
 * 已存在的同名选项直接沿用。dryRun 时照常执行再整体回滚，返回每一行会落到的位置（供预览）。
 */
export function importOutline(db: DB, propertyId: string, outline: string, opts: { dryRun?: boolean | undefined } = {}): OutlineImportResultDTO {
  let result: OutlineImportResultDTO | undefined;
  try {
    db.transaction(() => {
      recordCatalog(db, 'properties');
      result = importOutlineTx(db, requireOptionDef(db, propertyId), outline, Boolean(opts.dryRun));
      if (opts.dryRun) throw DRY_RUN;
    })();
  } catch (err) {
    if (err !== DRY_RUN) throw err;
  }
  return result!;
}

function importOutlineTx(db: DB, d: DefRow, outline: string, withItems: boolean): OutlineImportResultDTO {
  let created = 0;
  let existing = 0;
  const items: NonNullable<OutlineImportResultDTO['items']> = [];
  const stack: { indent: number; id: string; path: string }[] = [];
  for (const rawLine of outline.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    const expanded = rawLine.replace(/\t/g, '    ');
    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(expanded);
    let indent: number;
    let text: string;
    if (heading) {
      // 标题总比列表项浅：# 为最外层，其下的列表项成为它的下级
      indent = (heading[1]!.length - 10) * 100;
      text = heading[2]!;
    } else {
      indent = expanded.length - expanded.trimStart().length;
      text = expanded.trim().replace(/^([-*+•]|\d+[.)、]|[（(]\d+[)）])\s*/, '');
    }
    text = text.trim();
    if (!text) continue;
    const label = normalizeLabel(text.slice(0, 60));
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const up = d.nested ? stack.at(-1) : undefined;
    const parent = up?.id ?? null;
    const found = siblingByLabel(db, d.id, parent, label);
    const id = found ? found.id : insertOption(db, randomUUID(), d.id, parent, label);
    if (found) existing++;
    else created++;
    const path = up ? `${up.path}/${label}` : label;
    if (withItems && items.length < 2000) items.push({ path, depth: up ? path.split('/').length - 1 : 0, existing: Boolean(found) });
    stack.push({ indent, id, path });
  }
  return withItems ? { created, existing, items } : { created, existing };
}

// ---------------------------------------------------------------- 列表筛选、排序与导航

/** 把选项筛选展开为子树内全部选项 ID。 */
export function expandOptionFilter(db: DB, propertyId: string, optionIds: readonly string[]): string[] {
  const tree = optionTreeOf(db, propertyId);
  const out = new Set<string>();
  for (const id of optionIds) if (tree.byId.has(id)) for (const x of optionSubtree(tree, id)) out.add(x);
  return [...out];
}

/** 某个属性是否可以用于排序（未归档的单选，分层与否都可以）。 */
export function isSortableProperty(db: DB, propertyId: string): boolean {
  const d = db.prepare('SELECT * FROM property_defs WHERE id = ?').get(propertyId) as DefRow | undefined;
  return Boolean(d && d.archived_at === null && d.type === 'select');
}

/**
 * 按选项排序时的顺序：选项树的深度优先顺序（上级在前、同级按位置），不分层时即选项位置顺序。
 * 不可排序时返回 null。
 */
export function sortableOptionOrder(db: DB, propertyId: string): string[] | null {
  if (!isSortableProperty(db, propertyId)) return null;
  return optionTreeOf(db, propertyId).ordered.map((o) => o.id);
}

export interface NavPropertyCounts {
  propertyId: string;
  counts: Record<string, number>;
  none: number;
}

/** 导航中各属性选项（含子树）下不重复的对象数，以及未设置的对象数。只统计未删除的对象。 */
export function navPropertyCounts(db: DB, kind: OwnerKind, table: string): NavPropertyCounts[] {
  const col = ownerColumn(kind);
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL`).get() as { n: number }).n;
  const out: NavPropertyCounts[] = [];
  for (const d of managedDefs(db, kind)) {
    if (d.show_in_nav !== 1 || !(OPTION_TYPES.includes(d.type) || d.type === 'checkbox')) continue;
    const rows = db
      .prepare(`SELECT v.${col} AS owner, v.option_id, v.number_value FROM property_values v JOIN ${table} e ON e.id = v.${col} WHERE v.property_id = ? AND e.deleted_at IS NULL`)
      .all(d.id) as { owner: string; option_id: string | null; number_value: number | null }[];
    const counts: Record<string, number> = {};
    const withValue = new Set(rows.map((r) => r.owner));
    if (d.type === 'checkbox') {
      counts.__true__ = withValue.size;
    } else {
      const tree = optionTreeOf(db, d.id);
      const parentOf = new Map(tree.ordered.map((o) => [o.id, o.parentId]));
      const sets = new Map<string, Set<string>>();
      for (const r of rows) {
        let cur: string | null | undefined = r.option_id;
        while (cur) {
          let s = sets.get(cur);
          if (!s) sets.set(cur, (s = new Set()));
          s.add(r.owner);
          cur = parentOf.get(cur);
        }
      }
      for (const [id, s] of sets) counts[id] = s.size;
    }
    out.push({ propertyId: d.id, counts, none: total - withValue.size });
  }
  return out;
}

/** 当前受管理的属性定义（给检索投影等内部使用）。 */
export function managedPropertyIds(db: DB, kind: OwnerKind): string[] {
  return managedDefs(db, kind).map((d) => d.id);
}
