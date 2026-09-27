/**
 * Schema v3：学生与作答记录（作答流水，参照 Anki 的 revlog）。
 * 迁移一经发布不得修改。作答记录是独立的数据，写入时不改变题目的内容版本。
 */
export const SCHEMA_V3 = `
CREATE TABLE students (
  id            TEXT PRIMARY KEY NOT NULL,
  name          TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  stage         TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  archived_at   TEXT,
  write_version INTEGER NOT NULL DEFAULT 1 CHECK (write_version >= 1)
) STRICT;

-- 每次作答一条；做过、错几次、最近的主观难度都由流水统计
CREATE TABLE student_attempts (
  id              TEXT PRIMARY KEY NOT NULL,
  student_id      TEXT NOT NULL REFERENCES students (id),
  problem_id      TEXT NOT NULL REFERENCES problems (id),
  attempted_at    TEXT NOT NULL,
  result          TEXT NOT NULL CHECK (result IN ('correct', 'partial', 'wrong', 'blank')),
  felt_difficulty INTEGER CHECK (felt_difficulty IS NULL OR felt_difficulty BETWEEN 1 AND 5),
  duration_sec    INTEGER CHECK (duration_sec IS NULL OR duration_sec >= 0),
  note            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
) STRICT;
CREATE INDEX attempts_student ON student_attempts (student_id, problem_id, attempted_at);
CREATE INDEX attempts_problem ON student_attempts (problem_id);
`;
