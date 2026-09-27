/** 字典、标签、回收站等辅助查询。 */
import type { NavCountDTO, NavDTO, TagDTO, TrashDTO } from '../../shared/api.js';
import type { NoteType } from '../../shared/constants.js';
import { ancestorKeys, tagKey } from '../../shared/tagPath.js';
import type { DB } from '../db/connection.js';
import { plainSummary } from './markdown.js';
import { navPropertyCounts } from './properties.js';
import { ownerColumn, ownerTable, tagTable, type OwnerKind } from './rows.js';

export function getDictionary(db: DB): { subjects: string[]; stages: string[] } {
  const list = (kind: 'subject' | 'stage', col: 'subject' | 'stage') => {
    const dict = (
      db.prepare('SELECT value FROM dict_entries WHERE kind = ? ORDER BY position, value').all(kind) as { value: string }[]
    ).map((r) => r.value);
    // 用户自由填写过的值也作为可选项（简单可扩展字典）
    const used = (
      db
        .prepare(
          `SELECT DISTINCT ${col} AS v FROM problems WHERE ${col} IS NOT NULL
           UNION SELECT DISTINCT ${col} FROM materials WHERE ${col} IS NOT NULL ORDER BY 1`,
        )
        .all() as { v: string }[]
    ).map((r) => r.v);
    return [...dict, ...used.filter((v) => !dict.includes(v))];
  };
  return { subjects: list('subject', 'subject'), stages: list('stage', 'stage') };
}

/** 标签列表；默认只列出至少被一个未删除对象使用的标签，all 为真时包含全部。 */
export function listTags(db: DB, opts: { all?: boolean } = {}): TagDTO[] {
  return (
    db
      .prepare(
        `SELECT t.id, t.name,
           (SELECT COUNT(*) FROM problem_tags pt JOIN problems p ON p.id = pt.problem_id WHERE pt.tag_id = t.id AND p.deleted_at IS NULL) AS problem_count,
           (SELECT COUNT(*) FROM material_tags mt JOIN materials m ON m.id = mt.material_id WHERE mt.tag_id = t.id AND m.deleted_at IS NULL) AS material_count
         FROM tags t ORDER BY t.name COLLATE NOCASE`,
      )
      .all() as { id: string; name: string; problem_count: number; material_count: number }[]
  )
    .map((r) => ({ id: r.id, name: r.name, problemCount: r.problem_count, materialCount: r.material_count }))
    .filter((t) => opts.all || t.problemCount + t.materialCount > 0);
}

/**
 * 导航面板的计数：库、标签树（子树计数按不重复的对象算）、无标签、学科/学段各值。
 * 只统计未删除的对象。
 */
export function getNav(db: DB, kind: OwnerKind): NavDTO {
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params) as { n: number }).n;
  const library = {
    problems: count('SELECT COUNT(*) AS n FROM problems WHERE deleted_at IS NULL'),
    materials: count('SELECT COUNT(*) AS n FROM materials WHERE deleted_at IS NULL'),
    inbox: count("SELECT COUNT(*) AS n FROM materials WHERE deleted_at IS NULL AND status = 'inbox'"),
  };
  const table = ownerTable(kind);
  const col = ownerColumn(kind);
  const pairs = db
    .prepare(
      `SELECT x.${col} AS owner, t.id, t.name FROM ${tagTable(kind)} x
       JOIN tags t ON t.id = x.tag_id JOIN ${table} e ON e.id = x.${col} WHERE e.deleted_at IS NULL`,
    )
    .all() as { owner: string; id: string; name: string }[];
  const direct = new Map<string, { id: string; name: string; count: number }>();
  const subtree = new Map<string, Set<string>>();
  for (const p of pairs) {
    const d = direct.get(p.id) ?? { id: p.id, name: p.name, count: 0 };
    d.count++;
    direct.set(p.id, d);
    const key = tagKey(p.name);
    if (!key) continue;
    for (const k of ancestorKeys(key)) {
      let set = subtree.get(k);
      if (!set) subtree.set(k, (set = new Set()));
      set.add(p.owner);
    }
  }
  const tagTreeCounts: Record<string, number> = {};
  for (const [k, set] of subtree) tagTreeCounts[k] = set.size;
  const untagged = count(
    `SELECT COUNT(*) AS n FROM ${table} e WHERE e.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM ${tagTable(kind)} x WHERE x.${col} = e.id)`,
  );
  const values = (column: 'subject' | 'stage'): NavCountDTO[] => {
    const dictOrder = (
      db.prepare('SELECT value FROM dict_entries WHERE kind = ? ORDER BY position, value').all(column) as { value: string }[]
    ).map((r) => r.value);
    const rows = db
      .prepare(`SELECT ${column} AS value, COUNT(*) AS count FROM ${table} WHERE deleted_at IS NULL AND ${column} IS NOT NULL GROUP BY ${column}`)
      .all() as NavCountDTO[];
    const rank = (v: string) => {
      const i = dictOrder.indexOf(v);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return rows.sort((a, b) => rank(a.value) - rank(b.value) || a.value.localeCompare(b.value, 'zh-Hans-CN'));
  };
  return {
    library,
    tags: [...direct.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    tagTreeCounts,
    untagged,
    subjects: values('subject'),
    stages: values('stage'),
    noSubject: count(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL AND subject IS NULL`),
    noStage: count(`SELECT COUNT(*) AS n FROM ${table} WHERE deleted_at IS NULL AND stage IS NULL`),
    properties: navPropertyCounts(db, kind, table),
  };
}

function firstTextSummary(db: DB, col: 'problem_id' | 'material_id', id: string): string {
  const b = db
    .prepare(
      `SELECT kind, body, caption FROM content_blocks WHERE ${col} = ? AND (body IS NOT NULL AND body <> '' OR caption IS NOT NULL) ORDER BY position LIMIT 1`,
    )
    .get(id) as { kind: string; body: string | null; caption: string | null } | undefined;
  if (!b) return '';
  return b.kind === 'markdown' ? plainSummary(b.body ?? '', 80) : (b.body ?? b.caption ?? '').slice(0, 80);
}

export function getTrash(db: DB): TrashDTO {
  const problems = (
    db.prepare('SELECT id, title, deleted_at FROM problems WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all() as {
      id: string;
      title: string | null;
      deleted_at: string;
    }[]
  ).map((r) => ({ id: r.id, title: r.title, deletedAt: r.deleted_at, summary: firstTextSummary(db, 'problem_id', r.id) }));
  const materials = (
    db.prepare('SELECT id, title, deleted_at FROM materials WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC').all() as {
      id: string;
      title: string | null;
      deleted_at: string;
    }[]
  ).map((r) => ({ id: r.id, title: r.title, deletedAt: r.deleted_at, summary: firstTextSummary(db, 'material_id', r.id) }));
  const notes = (
    db
      .prepare(
        `SELECT n.id, n.problem_id, n.type, n.title, n.body_md, n.deleted_at, p.title AS problem_title, p.deleted_at AS problem_deleted_at
         FROM notes n JOIN problems p ON p.id = n.problem_id WHERE n.deleted_at IS NOT NULL ORDER BY n.deleted_at DESC`,
      )
      .all() as {
      id: string;
      problem_id: string;
      type: NoteType;
      title: string | null;
      body_md: string;
      deleted_at: string;
      problem_title: string | null;
      problem_deleted_at: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    problemId: r.problem_id,
    problemTitle: r.problem_title,
    problemDeleted: r.problem_deleted_at !== null,
    type: r.type,
    title: r.title,
    summary: plainSummary(r.body_md, 80),
    deletedAt: r.deleted_at,
  }));
  return { problems, materials, notes };
}
