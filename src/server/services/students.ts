/**
 * 学生与作答记录（作答流水）。
 * - 每次作答一条记录；做过、错几次、最近一次结果与主观难度都由流水统计，不另存状态。
 * - 作答记录与题目内容相互独立：写入作答不改变题目的 write_version / updated_at。
 * - 删除作答为软删除，可恢复；学生只归档不删除。
 */
import type { AttemptDTO, AttemptSummaryDTO, StudentDetailDTO, StudentDTO, StudentStatsDTO, WeakPointDTO } from '../../shared/api.js';
import type { AttemptResult } from '../../shared/constants.js';
import { nowIso, type DB } from '../db/connection.js';
import { AppError } from '../errors.js';
import { plainSummary } from './markdown.js';
import { normalizeShortText, placeholders } from './rows.js';

interface StudentRow {
  id: string;
  name: string;
  stage: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  write_version: number;
}

interface AttemptRow {
  id: string;
  student_id: string;
  problem_id: string;
  attempted_at: string;
  result: AttemptResult;
  felt_difficulty: number | null;
  duration_sec: number | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** 没做对的程度：错与不会为 1，半对为 0.5。 */
const MISS: Record<AttemptResult, number> = { correct: 0, partial: 0.5, wrong: 1, blank: 1 };

function getStudentRow(db: DB, id: string): StudentRow {
  const s = db.prepare('SELECT * FROM students WHERE id = ?').get(id) as StudentRow | undefined;
  if (!s) throw new AppError('NOT_FOUND', '学生不存在');
  return s;
}

function studentStats(db: DB, studentId: string): StudentStatsDTO {
  const rows = db
    .prepare(
      `SELECT a.problem_id, a.result, a.attempted_at FROM student_attempts a JOIN problems p ON p.id = a.problem_id
       WHERE a.student_id = ? AND a.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY a.attempted_at, a.id`,
    )
    .all(studentId) as { problem_id: string; result: AttemptResult; attempted_at: string }[];
  const last = new Map<string, AttemptResult>();
  const counts = { correct: 0, partial: 0, wrong: 0, blank: 0 };
  for (const r of rows) {
    counts[r.result]++;
    last.set(r.problem_id, r.result);
  }
  return {
    problems: last.size,
    attempts: rows.length,
    ...counts,
    openMistakes: [...last.values()].filter((r) => r !== 'correct').length,
    lastAttemptAt: rows.at(-1)?.attempted_at ?? null,
  };
}

function toStudentDTO(db: DB, s: StudentRow): StudentDTO {
  return {
    id: s.id,
    name: s.name,
    stage: s.stage,
    note: s.note,
    archived: s.archived_at !== null,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    version: s.write_version,
    stats: studentStats(db, s.id),
  };
}

export function listStudents(db: DB, opts: { includeArchived?: boolean } = {}): StudentDTO[] {
  return (db.prepare('SELECT * FROM students ORDER BY archived_at IS NOT NULL, name COLLATE NOCASE, created_at').all() as StudentRow[])
    .filter((s) => opts.includeArchived || s.archived_at === null)
    .map((s) => toStudentDTO(db, s));
}

function requireName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n || n.length > 60) throw new AppError('VALIDATION', '学生姓名应为 1–60 个字');
  return n;
}

export function createStudent(db: DB, input: { id: string; name: string; stage?: string | null | undefined; note?: string | null | undefined }): { student: StudentDTO; created: boolean } {
  const id = input.id.toLowerCase();
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM students WHERE id = ?').get(id) as StudentRow | undefined;
    if (existing) return { student: toStudentDTO(db, existing), created: false };
    const now = nowIso();
    db.prepare('INSERT INTO students (id, name, stage, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      requireName(input.name),
      normalizeShortText(input.stage),
      normalizeShortText(input.note),
      now,
      now,
    );
    return { student: toStudentDTO(db, getStudentRow(db, id)), created: true };
  })();
}

export function updateStudent(
  db: DB,
  id: string,
  input: { name?: string | undefined; stage?: string | null | undefined; note?: string | null | undefined; expectedVersion?: number | undefined },
): StudentDTO {
  return db.transaction(() => {
    const s = getStudentRow(db, id);
    if (input.expectedVersion !== undefined && input.expectedVersion !== s.write_version) {
      throw new AppError('CONFLICT', '学生信息已在其他页面被修改', { details: { currentVersion: s.write_version } });
    }
    const next = {
      name: input.name !== undefined ? requireName(input.name) : s.name,
      stage: input.stage !== undefined ? normalizeShortText(input.stage) : s.stage,
      note: input.note !== undefined ? normalizeShortText(input.note) : s.note,
    };
    if (next.name !== s.name || next.stage !== s.stage || next.note !== s.note) {
      db.prepare('UPDATE students SET name = ?, stage = ?, note = ?, updated_at = ?, write_version = write_version + 1 WHERE id = ?').run(
        next.name,
        next.stage,
        next.note,
        nowIso(),
        s.id,
      );
    }
    return toStudentDTO(db, getStudentRow(db, s.id));
  })();
}

export function setStudentArchived(db: DB, id: string, archived: boolean): StudentDTO {
  return db.transaction(() => {
    const s = getStudentRow(db, id);
    if ((s.archived_at !== null) !== archived) {
      db.prepare('UPDATE students SET archived_at = ?, updated_at = ?, write_version = write_version + 1 WHERE id = ?').run(
        archived ? nowIso() : null,
        nowIso(),
        s.id,
      );
    }
    return toStudentDTO(db, getStudentRow(db, s.id));
  })();
}

// ---------------------------------------------------------------- 作答

function attemptDTOs(db: DB, rows: AttemptRow[]): AttemptDTO[] {
  if (rows.length === 0) return [];
  const pids = [...new Set(rows.map((r) => r.problem_id))];
  const sids = [...new Set(rows.map((r) => r.student_id))];
  const problems = new Map(
    (db.prepare(`SELECT id, title, deleted_at FROM problems WHERE id IN (${placeholders(pids.length)})`).all(...pids) as {
      id: string;
      title: string | null;
      deleted_at: string | null;
    }[]).map((p) => [p.id, p]),
  );
  const summaries = new Map<string, string>();
  const firstText = db.prepare(
    "SELECT kind, body FROM content_blocks WHERE problem_id = ? AND kind IN ('markdown', 'text') AND body <> '' ORDER BY position LIMIT 1",
  );
  for (const pid of pids) {
    const b = firstText.get(pid) as { kind: string; body: string } | undefined;
    summaries.set(pid, b ? (b.kind === 'markdown' ? plainSummary(b.body, 80) : b.body.replace(/\s+/g, ' ').slice(0, 80)) : '');
  }
  const names = new Map(
    (db.prepare(`SELECT id, name FROM students WHERE id IN (${placeholders(sids.length)})`).all(...sids) as { id: string; name: string }[]).map((s) => [
      s.id,
      s.name,
    ]),
  );
  return rows.map((r) => ({
    id: r.id,
    studentId: r.student_id,
    studentName: names.get(r.student_id) ?? '',
    problemId: r.problem_id,
    problemTitle: problems.get(r.problem_id)?.title ?? null,
    problemSummary: summaries.get(r.problem_id) ?? '',
    problemDeleted: problems.get(r.problem_id)?.deleted_at != null,
    attemptedAt: r.attempted_at,
    result: r.result,
    feltDifficulty: r.felt_difficulty,
    durationSec: r.duration_sec,
    note: r.note,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function listAttempts(db: DB, filter: { studentId?: string | undefined; problemId?: string | undefined; limit?: number | undefined }): AttemptDTO[] {
  const where = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (filter.studentId) {
    where.push('student_id = ?');
    params.push(filter.studentId);
  }
  if (filter.problemId) {
    where.push('problem_id = ?');
    params.push(filter.problemId);
  }
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const rows = db
    .prepare(`SELECT * FROM student_attempts WHERE ${where.join(' AND ')} ORDER BY attempted_at DESC, id DESC LIMIT ?`)
    .all(...params, limit) as AttemptRow[];
  return attemptDTOs(db, rows);
}

interface AttemptFields {
  result: AttemptResult;
  feltDifficulty?: number | null | undefined;
  durationSec?: number | null | undefined;
  note?: string | null | undefined;
  attemptedAt?: string | undefined;
}

function checkTargets(db: DB, studentId: string, problemIds: readonly string[]): void {
  const s = getStudentRow(db, studentId);
  if (s.archived_at) throw new AppError('VALIDATION', `学生“${s.name}”已归档，不能再记录作答`);
  for (const pid of problemIds) {
    const p = db.prepare('SELECT deleted_at FROM problems WHERE id = ?').get(pid) as { deleted_at: string | null } | undefined;
    if (!p) throw new AppError('NOT_FOUND', `题目不存在：${pid}`);
    if (p.deleted_at) throw new AppError('VALIDATION', '不能给回收站中的题目记录作答');
  }
}

function insertAttempt(db: DB, id: string, studentId: string, problemId: string, f: AttemptFields, now: string): boolean {
  if (db.prepare('SELECT 1 FROM student_attempts WHERE id = ?').get(id)) return false;
  const at = f.attemptedAt ? new Date(f.attemptedAt).toISOString() : now;
  db.prepare(
    `INSERT INTO student_attempts (id, student_id, problem_id, attempted_at, result, felt_difficulty, duration_sec, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, studentId, problemId, at, f.result, f.feltDifficulty ?? null, f.durationSec ?? null, normalizeShortText(f.note), now, now);
  return true;
}

/** 记录一次作答。按客户端 ID 幂等：重试不会产生第二条。不改变题目的版本。 */
export function createAttempt(db: DB, input: { id: string; studentId: string; problemId: string } & AttemptFields): { attempt: AttemptDTO; created: boolean } {
  const id = input.id.toLowerCase();
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM student_attempts WHERE id = ?').get(id) as AttemptRow | undefined;
    if (existing) {
      if (existing.student_id !== input.studentId.toLowerCase() || existing.problem_id !== input.problemId.toLowerCase()) {
        throw new AppError('CONFLICT', '作答记录 ID 已被占用');
      }
      return { attempt: attemptDTOs(db, [existing])[0]!, created: false };
    }
    const sid = input.studentId.toLowerCase();
    const pid = input.problemId.toLowerCase();
    checkTargets(db, sid, [pid]);
    insertAttempt(db, id, sid, pid, input, nowIso());
    const row = db.prepare('SELECT * FROM student_attempts WHERE id = ?').get(id) as AttemptRow;
    return { attempt: attemptDTOs(db, [row])[0]!, created: true };
  })();
}

/** 批量记录：同一个学生、同一结果，给每道题各记一条。 */
export function createAttemptsBatch(db: DB, input: { studentId: string; items: { id: string; problemId: string }[] } & AttemptFields): { created: number } {
  return db.transaction(() => {
    const sid = input.studentId.toLowerCase();
    checkTargets(
      db,
      sid,
      input.items.map((i) => i.problemId.toLowerCase()),
    );
    const now = nowIso();
    let created = 0;
    for (const it of input.items) if (insertAttempt(db, it.id.toLowerCase(), sid, it.problemId.toLowerCase(), input, now)) created++;
    return { created };
  })();
}

export function updateAttempt(
  db: DB,
  id: string,
  input: { result?: AttemptResult | undefined; feltDifficulty?: number | null | undefined; durationSec?: number | null | undefined; note?: string | null | undefined; attemptedAt?: string | undefined },
): AttemptDTO {
  return db.transaction(() => {
    const r = db.prepare('SELECT * FROM student_attempts WHERE id = ?').get(id) as AttemptRow | undefined;
    if (!r || r.deleted_at) throw new AppError('NOT_FOUND', '作答记录不存在');
    const next = {
      result: input.result ?? r.result,
      felt: input.feltDifficulty !== undefined ? input.feltDifficulty : r.felt_difficulty,
      duration: input.durationSec !== undefined ? input.durationSec : r.duration_sec,
      note: input.note !== undefined ? normalizeShortText(input.note) : r.note,
      at: input.attemptedAt ? new Date(input.attemptedAt).toISOString() : r.attempted_at,
    };
    db.prepare(
      'UPDATE student_attempts SET result = ?, felt_difficulty = ?, duration_sec = ?, note = ?, attempted_at = ?, updated_at = ? WHERE id = ?',
    ).run(next.result, next.felt, next.duration, next.note, next.at, nowIso(), r.id);
    return attemptDTOs(db, [db.prepare('SELECT * FROM student_attempts WHERE id = ?').get(r.id) as AttemptRow])[0]!;
  })();
}

export function setAttemptDeleted(db: DB, id: string, deleted: boolean): void {
  db.transaction(() => {
    const r = db.prepare('SELECT * FROM student_attempts WHERE id = ?').get(id) as AttemptRow | undefined;
    if (!r) throw new AppError('NOT_FOUND', '作答记录不存在');
    if ((r.deleted_at !== null) === deleted) return;
    db.prepare('UPDATE student_attempts SET deleted_at = ?, updated_at = ? WHERE id = ?').run(deleted ? nowIso() : null, nowIso(), r.id);
  })();
}

// ---------------------------------------------------------------- 列表与统计

/** 列表筛选：按某个学生的作答状态。返回 SQL 条件与参数（e 为题目表别名）。 */
export function attemptFilterSql(studentId: string, filter: string): { sql: string; params: unknown[] } | null {
  const live = 'a.student_id = ? AND a.problem_id = e.id AND a.deleted_at IS NULL';
  switch (filter) {
    case 'none':
      return { sql: `NOT EXISTS (SELECT 1 FROM student_attempts a WHERE ${live})`, params: [studentId] };
    case 'done':
      return { sql: `EXISTS (SELECT 1 FROM student_attempts a WHERE ${live})`, params: [studentId] };
    case 'wrong-ever':
      return { sql: `EXISTS (SELECT 1 FROM student_attempts a WHERE ${live} AND a.result <> 'correct')`, params: [studentId] };
    case 'wrong-last':
      return {
        sql: `(SELECT a.result FROM student_attempts a WHERE ${live} ORDER BY a.attempted_at DESC, a.id DESC LIMIT 1) IN ('partial', 'wrong', 'blank')`,
        params: [studentId],
      };
    default:
      return null;
  }
}

/** 列表项上该学生的作答摘要。 */
export function attemptSummary(db: DB, studentId: string, problemId: string): AttemptSummaryDTO | null {
  const rows = db
    .prepare('SELECT result, attempted_at, felt_difficulty FROM student_attempts WHERE student_id = ? AND problem_id = ? AND deleted_at IS NULL ORDER BY attempted_at, id')
    .all(studentId, problemId) as { result: AttemptResult; attempted_at: string; felt_difficulty: number | null }[];
  if (rows.length === 0) return null;
  const last = rows.at(-1)!;
  const felt = [...rows].reverse().find((r) => r.felt_difficulty !== null)?.felt_difficulty ?? null;
  return {
    count: rows.length,
    wrong: rows.filter((r) => r.result === 'wrong' || r.result === 'blank').length,
    partial: rows.filter((r) => r.result === 'partial').length,
    lastResult: last.result,
    lastAt: last.attempted_at,
    lastFelt: felt,
  };
}

/**
 * 薄弱考点：把学生每次作答计入题目所属考点及其全部上级，统计没做对的比例。
 * 只列出作答次数达到 minAttempts 的考点，按没做对的比例从高到低。
 */
export function weakPoints(db: DB, studentId: string, minAttempts = 3, limit = 15): WeakPointDTO[] {
  const kp = db.prepare("SELECT id FROM property_defs WHERE preset = 'knowledge' AND archived_at IS NULL").get() as { id: string } | undefined;
  if (!kp) return [];
  const options = db.prepare('SELECT id, parent_id, label FROM property_options WHERE property_id = ? AND deleted_at IS NULL').all(kp.id) as {
    id: string;
    parent_id: string | null;
    label: string;
  }[];
  const byId = new Map(options.map((o) => [o.id, o]));
  const pathOf = (id: string): string => {
    const parts: string[] = [];
    let cur = byId.get(id);
    while (cur) {
      parts.unshift(cur.label);
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return parts.join('/');
  };
  const attempts = db
    .prepare(
      `SELECT a.problem_id, a.result FROM student_attempts a JOIN problems p ON p.id = a.problem_id
       WHERE a.student_id = ? AND a.deleted_at IS NULL AND p.deleted_at IS NULL`,
    )
    .all(studentId) as { problem_id: string; result: AttemptResult }[];
  if (attempts.length === 0) return [];
  const pids = [...new Set(attempts.map((a) => a.problem_id))];
  const optionsOf = new Map<string, string[]>();
  for (const r of db
    .prepare(`SELECT problem_id, option_id FROM property_values WHERE property_id = ? AND problem_id IN (${placeholders(pids.length)})`)
    .all(kp.id, ...pids) as { problem_id: string; option_id: string }[]) {
    optionsOf.set(r.problem_id, [...(optionsOf.get(r.problem_id) ?? []), r.option_id]);
  }
  const stats = new Map<string, { attempts: number; misses: number; problems: Set<string> }>();
  for (const a of attempts) {
    // 同一次作答对同一个上级考点只计一次
    const nodes = new Set<string>();
    for (const oid of optionsOf.get(a.problem_id) ?? []) {
      let cur = byId.get(oid);
      while (cur) {
        nodes.add(cur.id);
        cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
      }
    }
    for (const n of nodes) {
      const s = stats.get(n) ?? { attempts: 0, misses: 0, problems: new Set<string>() };
      s.attempts++;
      s.misses += MISS[a.result];
      s.problems.add(a.problem_id);
      stats.set(n, s);
    }
  }
  return [...stats]
    .filter(([, s]) => s.attempts >= minAttempts)
    .map(([id, s]) => ({ optionId: id, path: pathOf(id), attempts: s.attempts, misses: s.misses, problems: s.problems.size, missRate: s.misses / s.attempts }))
    .sort((a, b) => b.missRate - a.missRate || b.attempts - a.attempts || a.path.localeCompare(b.path, 'zh-Hans-CN'))
    .slice(0, limit);
}

export function getStudentDetail(db: DB, id: string): StudentDetailDTO {
  const s = getStudentRow(db, id);
  return {
    ...toStudentDTO(db, s),
    weakPoints: weakPoints(db, s.id),
    recentAttempts: listAttempts(db, { studentId: s.id, limit: 50 }),
  };
}
