/**
 * Schema v5：教案（把选中的题目按顺序组合起来）。
 * 迁移一经发布不得修改。教案按引用使用题目：题目改了，教案里看到的就是新内容；
 * 教案的修改不改变题目的 write_version / updated_at，反之亦然。
 */
export const SCHEMA_V5 = `
CREATE TABLE lessons (
  id            TEXT PRIMARY KEY NOT NULL,
  title         TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  write_version INTEGER NOT NULL DEFAULT 1 CHECK (write_version >= 1)
) STRICT;
CREATE INDEX lessons_updated ON lessons (updated_at, id);

-- 教案里的题目：按 position 排序；同一道题在一份教案里只出现一次；note 是这道题的讲解要点
CREATE TABLE lesson_items (
  lesson_id   TEXT NOT NULL REFERENCES lessons (id),
  problem_id  TEXT NOT NULL REFERENCES problems (id),
  position    INTEGER NOT NULL,
  note        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (lesson_id, problem_id)
) STRICT;
CREATE UNIQUE INDEX lesson_items_position ON lesson_items (lesson_id, position);
CREATE INDEX lesson_items_problem ON lesson_items (problem_id);
`;
