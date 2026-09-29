/**
 * 分类管理：标签（按路径的层级）与学科/学段字典。
 * 凡是改变了题目/资料内容（标签挂接、学科/学段取值）的操作，都在同一事务内
 * 递增受影响对象的 write_version、刷新 updated_at 并重建检索投影。
 */
import { recordCatalog } from '../events/changes.js';
import { rewriteSavedSearches } from './savedSearches.js';
import type { DictEntryDTO, DictKind, DictManageDTO, TagRenameResultDTO } from '../../shared/api.js';
import { inSubtree, normalizeTagInput, splitTagPath, tagKey, TAG_SEP } from '../../shared/tagPath.js';
import { nowIso, type DB } from '../db/connection.js';
import { AppError } from '../errors.js';
import { bumpVersion } from './versioning.js';
import { normalizeShortText, placeholders, type OwnerKind } from './rows.js';
import { reindex } from './search.js';

const MAX_TAG_NAME = 60;

interface TagRow {
  id: string;
  name: string;
}

function allTags(db: DB): TagRow[] {
  return db.prepare('SELECT id, name FROM tags ORDER BY created_at, id').all() as TagRow[];
}

function subtreeTags(db: DB, path: string): TagRow[] {
  const pk = tagKey(path);
  if (!pk) throw new AppError('VALIDATION', '标签路径不能为空');
  return allTags(db).filter((t) => inSubtree(tagKey(t.name), pk));
}

/** 挂着这些标签的全部对象（含回收站中的）。 */
function ownersOfTags(db: DB, tagIds: readonly string[]): { kind: OwnerKind; id: string }[] {
  if (tagIds.length === 0) return [];
  const ph = placeholders(tagIds.length);
  const problems = db.prepare(`SELECT DISTINCT problem_id AS id FROM problem_tags WHERE tag_id IN (${ph})`).all(...tagIds) as {
    id: string;
  }[];
  const materials = db
    .prepare(`SELECT DISTINCT material_id AS id FROM material_tags WHERE tag_id IN (${ph})`)
    .all(...tagIds) as { id: string }[];
  return [
    ...problems.map((r) => ({ kind: 'problem' as const, id: r.id })),
    ...materials.map((r) => ({ kind: 'material' as const, id: r.id })),
  ];
}

type Owner = { kind: OwnerKind; id: string };

/** 同一操作里收集受影响的对象（去重），最后统一递增版本并重建检索投影，每个对象只处理一次。 */
class OwnerSet {
  private readonly map = new Map<string, Owner>();
  add(owners: readonly Owner[]): void {
    for (const o of owners) this.map.set(`${o.kind}:${o.id}`, o);
  }
  get size(): number {
    return this.map.size;
  }
  touch(db: DB, now = nowIso()): void {
    for (const o of this.map.values()) {
      bumpVersion(db, o.kind, o.id, now);
      reindex(db, o.kind, o.id);
    }
  }
}

/** 去掉位于其他所选路径子树内的路径（只保留最上层），并按 tagKey 去重。 */
function topmostPaths(paths: readonly string[]): string[] {
  const keyed = [...new Map(paths.map((p) => [tagKey(p), p])).entries()].filter(([k]) => k);
  return keyed.filter(([k]) => !keyed.some(([other]) => other !== k && inSubtree(k, other))).map(([, p]) => p);
}

/** 把 from 标签的全部挂接转到 into 上（已有的不重复），然后删除 from。 */
function mergeTagInto(db: DB, fromId: string, intoId: string): void {
  for (const [table, col] of [
    ['problem_tags', 'problem_id'],
    ['material_tags', 'material_id'],
  ] as const) {
    db.prepare(`INSERT OR IGNORE INTO ${table} (${col}, tag_id) SELECT ${col}, ? FROM ${table} WHERE tag_id = ?`).run(intoId, fromId);
    db.prepare(`DELETE FROM ${table} WHERE tag_id = ?`).run(fromId);
  }
  db.prepare('DELETE FROM tags WHERE id = ?').run(fromId);
}

/**
 * 标签改名或移动：整棵子树的前缀一起改写。
 * 新名称与已有标签重名（不区分大小写）时合并为同一个标签。
 */
export function renameTagPath(db: DB, from: string, to: string): TagRenameResultDTO {
  return db.transaction((): TagRenameResultDTO => {
    recordCatalog(db, 'tags');
    const owners = new OwnerSet();
    const r = renameTagPathTx(db, from, to, owners);
    owners.touch(db);
    return { ...r, affectedItems: owners.size };
  })();
}

/** 改名的实际步骤（调用方负责事务与收尾）；受影响的对象加入 owners。 */
function renameTagPathTx(db: DB, from: string, to: string, owners: OwnerSet): { renamed: number; merged: number } {
  const fromSegs = splitTagPath(from);
  const toName = normalizeTagInput(to);
  if (fromSegs.length === 0 || !toName) throw new AppError('VALIDATION', '标签路径不能为空');
  const fromKey = tagKey(from);
  const toKey = tagKey(toName);
  if (toKey !== fromKey && inSubtree(toKey, fromKey)) throw new AppError('VALIDATION', '不能把标签移动到它自己的下级');
  const toSegs = splitTagPath(toName);

  {
    const affected = subtreeTags(db, from);
    if (affected.length === 0) throw new AppError('NOT_FOUND', `标签“${from}”不存在`);
    const plan = affected.map((t) => {
      const name = [...toSegs, ...splitTagPath(t.name).slice(fromSegs.length)].join(TAG_SEP);
      if (name.length > MAX_TAG_NAME) throw new AppError('VALIDATION', `改名后的标签过长（最多 ${MAX_TAG_NAME} 字）：${name}`);
      return { ...t, newName: name };
    });
    if (plan.every((p) => p.name === p.newName)) return { renamed: 0, merged: 0 };

    owners.add(
      ownersOfTags(
        db,
        plan.map((p) => p.id),
      ),
    );
    // 第一步：先把要改名的标签移到临时名称，避免改名途中与子树内尚未处理的旧名称冲突
    const tmp = db.prepare('UPDATE tags SET name = ? WHERE id = ?');
    for (const p of plan) tmp.run(`~tmp~${p.id}`, p.id);
    // 第二步：按新名称落位；与子树外已有标签或已处理的标签重名时合并
    const affectedIds = new Set(plan.map((p) => p.id));
    const byLower = new Map<string, string>();
    for (const t of allTags(db)) if (!affectedIds.has(t.id)) byLower.set(t.name.toLowerCase(), t.id);
    let renamed = 0;
    let merged = 0;
    for (const p of plan) {
      const key = p.newName.toLowerCase();
      const target = byLower.get(key);
      if (target) {
        mergeTagInto(db, p.id, target);
        merged++;
      } else {
        tmp.run(p.newName, p.id);
        byLower.set(key, p.id);
        if (p.newName !== p.name) renamed++;
      }
    }
    // 常用检索里的标签路径跟着改
    rewriteSavedSearches(db, (q) => {
      if (q.k !== 'tag') return q;
      const paths = q.paths.map((path) => (inSubtree(tagKey(path), fromKey) ? [...toSegs, ...splitTagPath(path).slice(fromSegs.length)].join(TAG_SEP) : path));
      return { k: 'tag', paths: [...new Map(paths.map((x) => [tagKey(x), x])).values()] };
    });
    return { renamed, merged };
  }
}

/**
 * 把多个标签（各含子树）合并到同一个目标路径：每个源的子树整体改名到目标之下，重名的自动合并。
 * 一个事务完成；被多个源命中的对象只递增一次版本。
 */
export function mergeTagPaths(db: DB, from: readonly string[], to: string): TagRenameResultDTO {
  const toName = normalizeTagInput(to);
  if (!toName) throw new AppError('VALIDATION', '目标标签不能为空');
  const toKey = tagKey(toName);
  return db.transaction((): TagRenameResultDTO => {
    recordCatalog(db, 'tags');
    const owners = new OwnerSet();
    let renamed = 0;
    let merged = 0;
    for (const f of topmostPaths(from)) {
      if (tagKey(f) === toKey) continue;
      if (inSubtree(toKey, tagKey(f))) throw new AppError('VALIDATION', `不能把“${f}”合并到它自己的下级`);
      const r = renameTagPathTx(db, f, toName, owners);
      renamed += r.renamed;
      merged += r.merged;
    }
    owners.touch(db);
    return { renamed, merged, affectedItems: owners.size };
  })();
}

/**
 * 把多个标签（各含子树）移到 parent 之下（null 为顶层），保留各自的末级名称；与已有标签重名时合并。
 * 一个事务完成；被多个源命中的对象只递增一次版本。
 */
export function moveTagPaths(db: DB, paths: readonly string[], parent: string | null): TagRenameResultDTO {
  const parentName = parent === null ? '' : normalizeTagInput(parent);
  if (parent !== null && !parentName) throw new AppError('VALIDATION', '目标标签不能为空');
  const parentKey = tagKey(parentName);
  return db.transaction((): TagRenameResultDTO => {
    recordCatalog(db, 'tags');
    const owners = new OwnerSet();
    let renamed = 0;
    let merged = 0;
    for (const f of topmostPaths(paths)) {
      const last = splitTagPath(f).at(-1)!;
      const to = parentName ? `${parentName}${TAG_SEP}${last}` : last;
      if (tagKey(to) === tagKey(f)) continue;
      if (parentName && inSubtree(parentKey, tagKey(f))) throw new AppError('VALIDATION', `不能把“${f}”移到它自己的下级`);
      const r = renameTagPathTx(db, f, to, owners);
      renamed += r.renamed;
      merged += r.merged;
    }
    owners.touch(db);
    return { renamed, merged, affectedItems: owners.size };
  })();
}

/** 删除标签（含整棵子树）：从全部对象（含回收站中的）上解除挂接，再删除已无引用的标签行。 */
export function deleteTagPath(db: DB, path: string): { deleted: number; affectedItems: number } {
  return deleteTagPaths(db, [path]);
}

/**
 * 一次删除多个标签（各含子树）。父子同时选中时按父级处理；一个事务完成，
 * 被多个所选标签命中的对象只递增一次版本。全部路径都不存在时报 NOT_FOUND。
 */
export function deleteTagPaths(db: DB, paths: readonly string[]): { deleted: number; affectedItems: number } {
  return db.transaction(() => {
    recordCatalog(db, 'tags');
    const ids = new Set<string>();
    for (const p of topmostPaths(paths)) for (const t of subtreeTags(db, p)) ids.add(t.id);
    if (ids.size === 0) throw new AppError('NOT_FOUND', '标签不存在');
    const list = [...ids];
    const owners = new OwnerSet();
    owners.add(ownersOfTags(db, list));
    const ph = placeholders(list.length);
    db.prepare(`DELETE FROM problem_tags WHERE tag_id IN (${ph})`).run(...list);
    db.prepare(`DELETE FROM material_tags WHERE tag_id IN (${ph})`).run(...list);
    db.prepare(`DELETE FROM tags WHERE id IN (${ph})`).run(...list);
    owners.touch(db);
    // 常用检索里指向已删除标签的条件：去掉该路径；一个都不剩时标为失效（显示提示）
    const gone = topmostPaths(paths).map(tagKey);
    rewriteSavedSearches(db, (q) => {
      if (q.k !== 'tag') return q;
      const left = q.paths.filter((path) => !gone.some((g) => inSubtree(tagKey(path), g)));
      if (left.length === q.paths.length) return q;
      return left.length ? { k: 'tag', paths: left } : { k: 'false', reason: `标签“${q.paths.join('、')}”已删除` };
    });
    return { deleted: list.length, affectedItems: owners.size };
  })();
}

// ---------------------------------------------------------------- 学科/学段字典

function assertKind(kind: string): asserts kind is DictKind {
  if (kind !== 'subject' && kind !== 'stage') throw new AppError('NOT_FOUND', '接口不存在');
}

function dictEntries(db: DB, kind: DictKind): { value: string; position: number }[] {
  return db.prepare('SELECT value, position FROM dict_entries WHERE kind = ? ORDER BY position, value').all(kind) as {
    value: string;
    position: number;
  }[];
}

export function getDictManage(db: DB): DictManageDTO {
  const build = (kind: DictKind): DictEntryDTO[] => {
    const counts = new Map<string, { p: number; m: number }>();
    for (const [table, key] of [
      ['problems', 'p'],
      ['materials', 'm'],
    ] as const) {
      for (const r of db
        .prepare(`SELECT ${kind} AS v, COUNT(*) AS n FROM ${table} WHERE ${kind} IS NOT NULL AND deleted_at IS NULL GROUP BY ${kind}`)
        .all() as { v: string; n: number }[]) {
        const c = counts.get(r.v) ?? { p: 0, m: 0 };
        c[key] = r.n;
        counts.set(r.v, c);
      }
    }
    // 回收站中的对象也在使用的值，要能看到（计数为 0 也列出）
    for (const table of ['problems', 'materials'] as const) {
      for (const r of db.prepare(`SELECT DISTINCT ${kind} AS v FROM ${table} WHERE ${kind} IS NOT NULL`).all() as { v: string }[]) {
        if (!counts.has(r.v)) counts.set(r.v, { p: 0, m: 0 });
      }
    }
    const dict = dictEntries(db, kind).map((e) => e.value);
    const out: DictEntryDTO[] = dict.map((value) => ({
      value,
      inDict: true,
      problemCount: counts.get(value)?.p ?? 0,
      materialCount: counts.get(value)?.m ?? 0,
    }));
    for (const [value, c] of [...counts].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))) {
      if (!dict.includes(value)) out.push({ value, inDict: false, problemCount: c.p, materialCount: c.m });
    }
    return out;
  };
  return { subject: build('subject'), stage: build('stage') };
}

function requireValue(v: string): string {
  const t = normalizeShortText(v);
  if (!t) throw new AppError('VALIDATION', '名称不能为空');
  return t;
}

export function addDictEntry(db: DB, kind: string, value: string): void {
  assertKind(kind);
  const v = requireValue(value);
  db.transaction(() => {
    recordCatalog(db, 'dict');
    if (db.prepare('SELECT 1 FROM dict_entries WHERE kind = ? AND value = ?').get(kind, v)) return;
    const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM dict_entries WHERE kind = ?').get(kind) as { m: number };
    db.prepare('INSERT INTO dict_entries (kind, value, position) VALUES (?, ?, ?)').run(kind, v, max.m + 1);
  })();
}

/**
 * 改名或合并：题目与资料上的取值一并改写（递增版本）。
 * to 为 null 时从所有对象上清除这个值并移出字典。
 */
export function renameDictValue(db: DB, kind: string, from: string, to: string | null): { affectedItems: number } {
  assertKind(kind);
  return db.transaction(() => {
    recordCatalog(db, 'dict');
    const owners = new OwnerSet();
    renameDictValueTx(db, kind, from, to, owners);
    owners.touch(db);
    return { affectedItems: owners.size };
  })();
}

/** 改名/合并/清除的实际步骤（调用方负责事务与收尾）；改到的对象加入 owners。 */
function renameDictValueTx(db: DB, kind: DictKind, from: string, to: string | null, owners: OwnerSet): void {
  const src = requireValue(from);
  const dst = to === null ? null : requireValue(to);
  if (dst === src) return;
  const entries = dictEntries(db, kind);
  const srcEntry = entries.find((e) => e.value === src);
  const dstEntry = dst === null ? undefined : entries.find((e) => e.value === dst);
  if (srcEntry) {
    if (dst === null || dstEntry) db.prepare('DELETE FROM dict_entries WHERE kind = ? AND value = ?').run(kind, src);
    else db.prepare('UPDATE dict_entries SET value = ? WHERE kind = ? AND value = ?').run(dst, kind, src);
  }
  let affected = 0;
  for (const [table, ownerKind] of [
    ['problems', 'problem'],
    ['materials', 'material'],
  ] as const) {
    const ids = (db.prepare(`SELECT id FROM ${table} WHERE ${kind} = ?`).all(src) as { id: string }[]).map((r) => r.id);
    const set = db.prepare(`UPDATE ${table} SET ${kind} = ? WHERE id = ?`);
    for (const id of ids) set.run(dst, id);
    owners.add(ids.map((id) => ({ kind: ownerKind, id })));
    affected += ids.length;
  }
  if (!srcEntry && affected === 0) throw new AppError('NOT_FOUND', `没有“${src}”这个值`);
  // 常用检索里的这个值跟着改名；清除时去掉该值，一个都不剩时标为失效
  rewriteSavedSearches(db, (q) => {
    if (q.k !== 'dict' || q.field !== kind || !q.values.includes(src)) return q;
    const kept = dst === null ? q.values.filter((v) => v !== src) : [...new Set(q.values.map((v) => (v === src ? dst : v)))];
    return kept.length ? { k: 'dict', field: kind, values: kept } : { k: 'false', reason: `${kind === 'subject' ? '学科' : '学段'}“${src}”已清除` };
  });
}

/** 多个值一起合并到 into（to 为 null 时从所有对象上清除）；一个事务，每个对象只递增一次版本。 */
export function mergeDictValues(db: DB, kind: string, values: readonly string[], into: string | null): { affectedItems: number } {
  assertKind(kind);
  return db.transaction(() => {
    recordCatalog(db, 'dict');
    const owners = new OwnerSet();
    for (const v of new Set(values)) renameDictValueTx(db, kind, v, into, owners);
    owners.touch(db);
    return { affectedItems: owners.size };
  })();
}

/** 按给定顺序排列候选；列表中尚不在字典里的值会被加入字典。 */
export function reorderDict(db: DB, kind: string, values: readonly string[]): void {
  assertKind(kind);
  const wanted = [...new Set(values.map(requireValue))];
  db.transaction(() => {
    recordCatalog(db, 'dict');
    const existing = dictEntries(db, kind).map((e) => e.value);
    const rest = existing.filter((v) => !wanted.includes(v));
    const order = [...wanted, ...rest];
    db.prepare('DELETE FROM dict_entries WHERE kind = ?').run(kind);
    const insert = db.prepare('INSERT INTO dict_entries (kind, value, position) VALUES (?, ?, ?)');
    order.forEach((v, i) => insert.run(kind, v, i));
  })();
}

/** 从候选中移除；仍有对象在使用的值必须先合并到别的值。 */
export function removeDictEntry(db: DB, kind: string, value: string): void {
  removeDictEntries(db, kind, [value]);
}

/** 一次从候选中移除多个值；任何一个仍在使用就整体不做，并列出这些值。 */
export function removeDictEntries(db: DB, kind: string, values: readonly string[]): void {
  assertKind(kind);
  const list = [...new Set(values.map(requireValue))];
  db.transaction(() => {
    recordCatalog(db, 'dict');
    const inUse: string[] = [];
    for (const v of list) {
      const used =
        (db.prepare(`SELECT COUNT(*) AS n FROM problems WHERE ${kind} = ?`).get(v) as { n: number }).n +
        (db.prepare(`SELECT COUNT(*) AS n FROM materials WHERE ${kind} = ?`).get(v) as { n: number }).n;
      if (used > 0) inUse.push(`“${v}”（${used} 个对象）`);
    }
    if (inUse.length) throw new AppError('CONFLICT', `仍在使用：${inUse.join('、')}。请先合并到其他值或从对象上清除`);
    const del = db.prepare('DELETE FROM dict_entries WHERE kind = ? AND value = ?');
    for (const v of list) del.run(kind, v);
  })();
}
