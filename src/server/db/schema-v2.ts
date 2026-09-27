/**
 * Schema v2：自定义属性（题型、难度、考点等），并把 search_index 的 field 约束去掉。
 * 迁移一经发布不得修改；预置属性写在这里，不从业务代码导入，保证迁移结果固定。
 */
import { randomUUID } from 'node:crypto';
import type { DB } from './connection.js';

export const SCHEMA_V2 = `
CREATE TABLE property_defs (
  id               TEXT PRIMARY KEY NOT NULL,
  name             TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 40),
  type             TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'checkbox', 'select', 'multiselect')),
  nested           INTEGER NOT NULL DEFAULT 0 CHECK (nested IN (0, 1)),
  applies_problem  INTEGER NOT NULL CHECK (applies_problem IN (0, 1)),
  applies_material INTEGER NOT NULL CHECK (applies_material IN (0, 1)),
  preset           TEXT UNIQUE,
  position         INTEGER NOT NULL,
  show_in_nav      INTEGER NOT NULL DEFAULT 1 CHECK (show_in_nav IN (0, 1)),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  archived_at      TEXT,
  CHECK (nested = 0 OR type IN ('select', 'multiselect')),
  CHECK (applies_problem + applies_material >= 1)
) STRICT;
CREATE UNIQUE INDEX property_defs_live_name ON property_defs (name COLLATE NOCASE) WHERE archived_at IS NULL;

-- 选项可以成树（nested）；父节点必须属于同一个属性
CREATE TABLE property_options (
  id          TEXT PRIMARY KEY NOT NULL,
  property_id TEXT NOT NULL REFERENCES property_defs (id),
  parent_id   TEXT,
  label       TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 60 AND instr(label, '/') = 0),
  position    INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT,
  UNIQUE (id, property_id),
  CHECK (parent_id IS NULL OR parent_id <> id),
  FOREIGN KEY (parent_id, property_id) REFERENCES property_options (id, property_id)
) STRICT;
CREATE UNIQUE INDEX property_options_live_label ON property_options (property_id, ifnull(parent_id, ''), label COLLATE NOCASE) WHERE deleted_at IS NULL;
CREATE INDEX property_options_tree ON property_options (property_id, parent_id, position);

-- 属性值恰好属于一个题目或一个资料；选项值、文本值、数值三者恰好一个
CREATE TABLE property_values (
  problem_id   TEXT REFERENCES problems (id),
  material_id  TEXT REFERENCES materials (id),
  property_id  TEXT NOT NULL REFERENCES property_defs (id),
  option_id    TEXT,
  text_value   TEXT CHECK (text_value IS NULL OR length(text_value) BETWEEN 1 AND 2000),
  number_value REAL,
  FOREIGN KEY (option_id, property_id) REFERENCES property_options (id, property_id),
  CHECK ((problem_id IS NULL) <> (material_id IS NULL)),
  CHECK ((option_id IS NOT NULL) + (text_value IS NOT NULL) + (number_value IS NOT NULL) = 1)
) STRICT;
CREATE UNIQUE INDEX pv_problem_opt  ON property_values (problem_id, option_id)    WHERE problem_id IS NOT NULL AND option_id IS NOT NULL;
CREATE UNIQUE INDEX pv_material_opt ON property_values (material_id, option_id)   WHERE material_id IS NOT NULL AND option_id IS NOT NULL;
CREATE UNIQUE INDEX pv_problem_sc   ON property_values (problem_id, property_id)  WHERE problem_id IS NOT NULL AND option_id IS NULL;
CREATE UNIQUE INDEX pv_material_sc  ON property_values (material_id, property_id) WHERE material_id IS NOT NULL AND option_id IS NULL;
CREATE INDEX pv_problem  ON property_values (problem_id);
CREATE INDEX pv_material ON property_values (material_id);
CREATE INDEX pv_prop_opt ON property_values (property_id, option_id);

-- search_index 是可重建的派生数据：换表并去掉 field 上的 CHECK，以后新增检索字段不必再重建
CREATE TABLE search_index_v2 (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('problem', 'material')),
  owner_id   TEXT NOT NULL,
  field      TEXT NOT NULL,
  text       TEXT NOT NULL
) STRICT;
INSERT INTO search_index_v2 (owner_kind, owner_id, field, text) SELECT owner_kind, owner_id, field, text FROM search_index;
DROP TABLE search_index;
ALTER TABLE search_index_v2 RENAME TO search_index;
CREATE INDEX search_index_owner ON search_index (owner_kind, owner_id);
`;

interface PresetSeed {
  preset: string;
  name: string;
  type: 'select' | 'multiselect';
  nested: 0 | 1;
  problem: 0 | 1;
  material: 0 | 1;
  options: string[];
}

/** 预置属性：题型、难度（容易→困难，有顺序）、考点（层级多选，初始为空树）。 */
const PRESETS: PresetSeed[] = [
  { preset: 'qtype', name: '题型', type: 'select', nested: 0, problem: 1, material: 0, options: ['单选', '多选', '填空', '解答', '判断'] },
  { preset: 'difficulty', name: '难度', type: 'select', nested: 0, problem: 1, material: 0, options: ['容易', '较易', '中档', '较难', '困难'] },
  { preset: 'knowledge', name: '考点', type: 'multiselect', nested: 1, problem: 1, material: 1, options: [] },
];

export function migrateV2(db: DB): void {
  db.exec(SCHEMA_V2);
  const now = new Date().toISOString();
  const insertDef = db.prepare(
    `INSERT INTO property_defs (id, name, type, nested, applies_problem, applies_material, preset, position, show_in_nav, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  const insertOption = db.prepare(
    'INSERT INTO property_options (id, property_id, parent_id, label, position, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
  );
  PRESETS.forEach((p, i) => {
    const id = randomUUID();
    insertDef.run(id, p.name, p.type, p.nested, p.problem, p.material, p.preset, i, now, now);
    p.options.forEach((label, j) => insertOption.run(randomUUID(), id, label, j, now, now));
  });
}
