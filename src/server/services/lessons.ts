/**
 * 教案：把题目按顺序组合起来。按引用使用题目，不复制内容——题目改了，教案里看到的就是新内容。
 * - 客户端生成 ID，创建请求可安全重试；整体保存带 expectedVersion，不一致返回 409。
 * - 只有真正变化（标题、说明、题目的增删、顺序、讲解要点）才递增教案版本；没有变化的保存不递增。
 * - 教案与题目的版本互不影响：改教案不改变题目的 write_version / updated_at，反之亦然。
 * - 题目进了回收站，教案里的引用保留并标出；新加入的题目不能在回收站中。
 * - 删除教案为软删除，可在回收站恢复。
 */
import type { LessonAddItemsResultDTO, LessonDTO, LessonItemDTO, LessonItemInput, LessonListItemDTO, SaveResult } from '../../shared/api.js';
import { nowIso, type DB } from '../db/connection.js';
import { AppError } from '../errors.js';
import { recordLesson } from '../events/changes.js';
import { firstTextSummary } from './catalog.js';
import { normalizeShortText, placeholders } from './rows.js';

interface LessonRow {
  id: string;
  title: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  write_version: number;
}

interface ItemRow {
  lesson_id: string;
  problem_id: string;
  position: number;
  note: string | null;
  created_at: string;
}

export interface LessonWrite {
  title?: string | null | undefined;
  note?: string | null | undefined;
  items: LessonItemInput[];
}

/** 列表里预览的题数。 */
const PREVIEW_ITEMS = 3;

function getLessonRow(db: DB, id: string): LessonRow | undefined {
  return db.prepare('SELECT * FROM lessons WHERE id = ?').get(id) as LessonRow | undefined;
}

function loadItems(db: DB, lessonId: string): ItemRow[] {
  return db.prepare('SELECT * FROM lesson_items WHERE lesson_id = ? ORDER BY position').all(lessonId) as ItemRow[];
}

interface ProblemInfo {
  title: string | null;
  subject: string | null;
  stage: string | null;
  deleted: boolean;
  summary: string;
}

function problemInfo(db: DB, ids: readonly string[]): Map<string, ProblemInfo> {
  const out = new Map<string, ProblemInfo>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(`SELECT id, title, subject, stage, deleted_at FROM problems WHERE id IN (${placeholders(ids.length)})`)
    .all(...ids) as { id: string; title: string | null; subject: string | null; stage: string | null; deleted_at: string | null }[];
  for (const r of rows) {
    out.set(r.id, {
      title: r.title,
      subject: r.subject,
      stage: r.stage,
      deleted: r.deleted_at !== null,
      summary: firstTextSummary(db, 'problem_id', r.id),
    });
  }
  return out;
}

export function loadLesson(db: DB, id: string): LessonDTO | null {
  const row = getLessonRow(db, id);
  if (!row) return null;
  const items = loadItems(db, id);
  const info = problemInfo(
    db,
    items.map((i) => i.problem_id),
  );
  return {
    id: row.id,
    title: row.title,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: row.write_version,
    items: items.map((i): LessonItemDTO => {
      const p = info.get(i.problem_id);
      return {
        problemId: i.problem_id,
        note: i.note,
        title: p?.title ?? null,
        summary: p?.summary ?? '',
        subject: p?.subject ?? null,
        stage: p?.stage ?? null,
        deleted: p?.deleted ?? true,
      };
    }),
  };
}

export function getLesson(db: DB, id: string): LessonDTO {
  const l = loadLesson(db, id);
  if (!l) throw new AppError('NOT_FOUND', '教案不存在');
  return l;
}

/** 未删除的教案，最近修改的在前；给出 problemId 时只列出引用了这道题的。 */
export function listLessons(db: DB, filter: { problemId?: string | undefined } = {}): LessonListItemDTO[] {
  const rows = (
    filter.problemId
      ? db
          .prepare(
            `SELECT * FROM lessons WHERE deleted_at IS NULL
             AND id IN (SELECT lesson_id FROM lesson_items WHERE problem_id = ?) ORDER BY updated_at DESC, id`,
          )
          .all(filter.problemId)
      : db.prepare('SELECT * FROM lessons WHERE deleted_at IS NULL ORDER BY updated_at DESC, id').all()
  ) as LessonRow[];
  const count = db.prepare('SELECT COUNT(*) AS n FROM lesson_items WHERE lesson_id = ?');
  const head = db.prepare(
    `SELECT i.problem_id, p.title FROM lesson_items i JOIN problems p ON p.id = i.problem_id
     WHERE i.lesson_id = ? ORDER BY i.position LIMIT ${PREVIEW_ITEMS}`,
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.write_version,
    problemCount: (count.get(r.id) as { n: number }).n,
    preview: (head.all(r.id) as { problem_id: string; title: string | null }[]).map(
      (p) => p.title ?? (firstTextSummary(db, 'problem_id', p.problem_id) || '未命名题目'),
    ),
  }));
}

/** 递增教案版本并记录变更（教案版本的唯一入口）。 */
function bumpLessonVersion(db: DB, id: string, now: string): void {
  db.prepare('UPDATE lessons SET updated_at = ?, write_version = write_version + 1 WHERE id = ?').run(now, id);
  recordLesson(db, id);
}

/** 新加入的题目必须存在且不在回收站中。 */
function checkNewProblems(db: DB, ids: readonly string[]): void {
  const find = db.prepare('SELECT deleted_at FROM problems WHERE id = ?');
  for (const pid of ids) {
    const p = find.get(pid) as { deleted_at: string | null } | undefined;
    if (!p) throw new AppError('VALIDATION', `题目不存在：${pid}`);
    if (p.deleted_at) throw new AppError('VALIDATION', '不能把回收站中的题目加入教案');
  }
}

/** 以给定顺序整体写入教案里的题目；返回是否有改动。 */
function writeItems(db: DB, lessonId: string, input: LessonItemInput[], now: string): boolean {
  const ids = input.map((i) => i.problemId.toLowerCase());
  if (new Set(ids).size !== ids.length) throw new AppError('VALIDATION', '同一道题在一份教案里只能出现一次');
  const existing = new Map(loadItems(db, lessonId).map((r) => [r.problem_id, r]));
  checkNewProblems(
    db,
    ids.filter((pid) => !existing.has(pid)),
  );
  let changed = false;
  const keep = new Set(ids);
  const del = db.prepare('DELETE FROM lesson_items WHERE lesson_id = ? AND problem_id = ?');
  for (const pid of existing.keys()) {
    if (!keep.has(pid)) {
      del.run(lessonId, pid);
      changed = true;
    }
  }
  // 先把位置移到负数区，避免重排时触发唯一索引冲突
  db.prepare('UPDATE lesson_items SET position = -1 - position WHERE lesson_id = ?').run(lessonId);
  const update = db.prepare('UPDATE lesson_items SET position = ?, note = ? WHERE lesson_id = ? AND problem_id = ?');
  const insert = db.prepare('INSERT INTO lesson_items (lesson_id, problem_id, position, note, created_at) VALUES (?, ?, ?, ?, ?)');
  input.forEach((item, position) => {
    const pid = ids[position]!;
    const note = normalizeShortText(item.note);
    const prev = existing.get(pid);
    if (prev) {
      if (prev.position !== position || prev.note !== note) changed = true;
      update.run(position, note, lessonId, pid);
    } else {
      insert.run(lessonId, pid, position, note, now);
      changed = true;
    }
  });
  return changed;
}

/**
 * 整体保存一份教案（一个事务）。
 * - expectedVersion 为 null：新建；同 ID 已存在时不做任何事（重试安全）。
 * - 否则按版本条件更新：版本不符或在回收站中返回 409；只有真正变化时才递增版本。
 */
function saveLesson(db: DB, id: string, expectedVersion: number | null, input: LessonWrite): SaveResult<LessonDTO> {
  const result = db.transaction((): { created: boolean; changed: boolean } => {
    const row = getLessonRow(db, id);
    const now = nowIso();
    const title = normalizeShortText(input.title);
    const note = normalizeShortText(input.note);
    if (expectedVersion === null) {
      if (row) return { created: false, changed: false };
      db.prepare(
        `INSERT INTO lessons (id, title, note, created_at, updated_at, deleted_at, write_version) VALUES (?, ?, ?, ?, ?, NULL, 1)`,
      ).run(id, title, note, now, now);
      writeItems(db, id, input.items, now);
      recordLesson(db, id, 'created');
      return { created: true, changed: true };
    }
    if (!row) throw new AppError('NOT_FOUND', '教案不存在');
    if (row.deleted_at) {
      throw new AppError('CONFLICT', '该教案已在回收站中，请先恢复再编辑', { details: { currentVersion: row.write_version } });
    }
    if (row.write_version !== expectedVersion) {
      throw new AppError('CONFLICT', '该教案已在其他页面被修改，本页内容未保存', {
        details: { currentVersion: row.write_version, expectedVersion },
      });
    }
    let changed = false;
    if (title !== row.title || note !== row.note) {
      db.prepare('UPDATE lessons SET title = ?, note = ? WHERE id = ?').run(title, note, id);
      changed = true;
    }
    changed = writeItems(db, id, input.items, now) || changed;
    if (changed) bumpLessonVersion(db, id, now);
    return { created: false, changed };
  })();
  const lesson = loadLesson(db, id)!;
  return expectedVersion === null ? { entity: lesson, created: result.created, changed: result.changed } : { entity: lesson, changed: result.changed };
}

export function createLesson(db: DB, id: string, input: LessonWrite): SaveResult<LessonDTO> {
  return saveLesson(db, id.toLowerCase(), null, input);
}

export function updateLesson(db: DB, id: string, expectedVersion: number, input: LessonWrite): SaveResult<LessonDTO> {
  return saveLesson(db, id, expectedVersion, input);
}

/**
 * 把题目追加到教案末尾（保持给出的顺序）；已在教案里的跳过。
 * 有新加入的题目时递增教案版本，仍开着这份教案的旧页面保存时会得到 409，而不是把它们写丢。
 */
export function addProblemsToLesson(db: DB, lessonId: string, problemIds: readonly string[]): LessonAddItemsResultDTO {
  const r = db.transaction(() => {
    const row = getLessonRow(db, lessonId);
    if (!row) throw new AppError('NOT_FOUND', '教案不存在');
    if (row.deleted_at) throw new AppError('CONFLICT', '该教案已在回收站中，请先恢复');
    const existing = new Set(loadItems(db, lessonId).map((i) => i.problem_id));
    const wanted = [...new Set(problemIds.map((p) => p.toLowerCase()))];
    const fresh = wanted.filter((p) => !existing.has(p));
    checkNewProblems(db, fresh);
    const now = nowIso();
    const max = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM lesson_items WHERE lesson_id = ?').get(lessonId) as { m: number };
    const insert = db.prepare('INSERT INTO lesson_items (lesson_id, problem_id, position, note, created_at) VALUES (?, ?, ?, NULL, ?)');
    fresh.forEach((pid, i) => insert.run(lessonId, pid, max.m + 1 + i, now));
    if (fresh.length) bumpLessonVersion(db, lessonId, now);
    return { added: fresh.length, existing: wanted.length - fresh.length };
  })();
  return { lesson: getLesson(db, lessonId), ...r };
}

/** 移到回收站 / 恢复；与其他真实变化一样递增版本。 */
export function setLessonDeleted(db: DB, id: string, deleted: boolean): LessonDTO {
  db.transaction(() => {
    const row = getLessonRow(db, id);
    if (!row) throw new AppError('NOT_FOUND', '教案不存在');
    if ((row.deleted_at !== null) === deleted) return;
    const now = nowIso();
    db.prepare('UPDATE lessons SET deleted_at = ? WHERE id = ?').run(deleted ? now : null, id);
    bumpLessonVersion(db, id, now);
  })();
  return getLesson(db, id);
}
