/**
 * 分类管理：标签（按路径的层级）与学科/学段字典。
 * 凡是改变了题目/资料内容（标签挂接、学科/学段取值）的操作，都在同一事务内
 * 递增受影响对象的 write_version、刷新 updated_at 并重建检索投影。
 */
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

function touchOwners(db: DB, owners: readonly { kind: OwnerKind; id: string }[], now: string): void {
  for (const o of owners) {
    bumpVersion(db, o.kind, o.id, now);
    reindex(db, o.kind, o.id);
  }
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
  const fromSegs = splitTagPath(from);
  const toName = normalizeTagInput(to);
  if (fromSegs.length === 0 || !toName) throw new AppError('VALIDATION', '标签路径不能为空');
  const fromKey = tagKey(from);
  const toKey = tagKey(toName);
  if (toKey !== fromKey && inSubtree(toKey, fromKey)) throw new AppError('VALIDATION', '不能把标签移动到它自己的下级');
  const toSegs = splitTagPath(toName);

  return db.transaction((): TagRenameResultDTO => {
    const affected = subtreeTags(db, from);
    if (affected.length === 0) throw new AppError('NOT_FOUND', '标签不存在');
    const plan = affected.map((t) => {
      const name = [...toSegs, ...splitTagPath(t.name).slice(fromSegs.length)].join(TAG_SEP);
      if (name.length > MAX_TAG_NAME) throw new AppError('VALIDATION', `改名后的标签过长（最多 ${MAX_TAG_NAME} 字）：${name}`);
      return { ...t, newName: name };
    });
    if (plan.every((p) => p.name === p.newName)) return { renamed: 0, merged: 0, affectedItems: 0 };

    const owners = ownersOfTags(
      db,
      plan.map((p) => p.id),
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
    touchOwners(db, owners, nowIso());
    return { renamed, merged, affectedItems: owners.length };
  })();
}

/** 删除标签（含整棵子树）：从全部对象（含回收站中的）上解除挂接，再删除已无引用的标签行。 */
export function deleteTagPath(db: DB, path: string): { deleted: number; affectedItems: number } {
  return db.transaction(() => {
    const affected = subtreeTags(db, path);
    if (affected.length === 0) throw new AppError('NOT_FOUND', '标签不存在');
    const ids = affected.map((t) => t.id);
    const owners = ownersOfTags(db, ids);
    const ph = placeholders(ids.length);
    db.prepare(`DELETE FROM problem_tags WHERE tag_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM material_tags WHERE tag_id IN (${ph})`).run(...ids);
    db.prepare(`DELETE FROM tags WHERE id IN (${ph})`).run(...ids);
    touchOwners(db, owners, nowIso());
    return { deleted: ids.length, affectedItems: owners.length };
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
  const src = requireValue(from);
  const dst = to === null ? null : requireValue(to);
  if (dst === src) return { affectedItems: 0 };
  return db.transaction(() => {
    const entries = dictEntries(db, kind);
    const srcEntry = entries.find((e) => e.value === src);
    const dstEntry = dst === null ? undefined : entries.find((e) => e.value === dst);
    if (srcEntry) {
      if (dst === null || dstEntry) db.prepare('DELETE FROM dict_entries WHERE kind = ? AND value = ?').run(kind, src);
      else db.prepare('UPDATE dict_entries SET value = ? WHERE kind = ? AND value = ?').run(dst, kind, src);
    }
    const now = nowIso();
    let affected = 0;
    for (const [table, ownerKind] of [
      ['problems', 'problem'],
      ['materials', 'material'],
    ] as const) {
      const ids = (db.prepare(`SELECT id FROM ${table} WHERE ${kind} = ?`).all(src) as { id: string }[]).map((r) => r.id);
      const set = db.prepare(`UPDATE ${table} SET ${kind} = ? WHERE id = ?`);
      for (const id of ids) {
        set.run(dst, id);
        bumpVersion(db, ownerKind, id, now);
      }
      affected += ids.length;
    }
    if (!srcEntry && affected === 0) throw new AppError('NOT_FOUND', '没有这个值');
    return { affectedItems: affected };
  })();
}

/** 按给定顺序排列候选；列表中尚不在字典里的值会被加入字典。 */
export function reorderDict(db: DB, kind: string, values: readonly string[]): void {
  assertKind(kind);
  const wanted = [...new Set(values.map(requireValue))];
  db.transaction(() => {
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
  assertKind(kind);
  const v = requireValue(value);
  db.transaction(() => {
    const used =
      (db.prepare(`SELECT COUNT(*) AS n FROM problems WHERE ${kind} = ?`).get(v) as { n: number }).n +
      (db.prepare(`SELECT COUNT(*) AS n FROM materials WHERE ${kind} = ?`).get(v) as { n: number }).n;
    if (used > 0) throw new AppError('CONFLICT', `仍有 ${used} 个对象在使用“${v}”，请先合并到其他值`);
    db.prepare('DELETE FROM dict_entries WHERE kind = ? AND value = ?').run(kind, v);
  })();
}
