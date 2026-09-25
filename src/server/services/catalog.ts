/** 字典、标签、回收站等辅助查询。 */
import type { TagDTO, TrashDTO } from '../../shared/api.js';
import type { NoteType } from '../../shared/constants.js';
import type { DB } from '../db/connection.js';
import { plainSummary } from './markdown.js';

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

export function listTags(db: DB): TagDTO[] {
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
    .filter((t) => t.problemCount + t.materialCount > 0);
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
