/**
 * Schema v1。迁移一经发布不得修改，后续变更请新增迁移。
 * 所有时间字段为 UTC ISO-8601 字符串；所有 ID 为 UUID。
 */
export const SCHEMA_V1 = `
CREATE TABLE library_meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE dict_entries (
  kind     TEXT NOT NULL CHECK (kind IN ('subject', 'stage')),
  value    TEXT NOT NULL CHECK (length(trim(value)) BETWEEN 1 AND 50),
  position INTEGER NOT NULL,
  PRIMARY KEY (kind, value)
) STRICT;

CREATE TABLE assets (
  id                TEXT PRIMARY KEY NOT NULL,
  sha256            TEXT NOT NULL CHECK (length(sha256) = 64),
  rel_path          TEXT NOT NULL,
  mime              TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/markdown', 'text/plain')),
  size              INTEGER NOT NULL CHECK (size >= 0),
  original_filename TEXT,
  created_at        TEXT NOT NULL
) STRICT;
CREATE INDEX assets_sha256 ON assets (sha256);

CREATE TABLE remote_images (
  id            TEXT PRIMARY KEY NOT NULL,
  url           TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'archived', 'failed')),
  asset_id      TEXT REFERENCES assets (id),
  archived_via  TEXT CHECK (archived_via IN ('download', 'manual')),
  error_code    TEXT,
  error_message TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  CHECK ((status = 'archived') = (asset_id IS NOT NULL)),
  CHECK ((status = 'archived') = (archived_via IS NOT NULL))
) STRICT;

CREATE TABLE problems (
  id            TEXT PRIMARY KEY NOT NULL,
  title         TEXT CHECK (title IS NULL OR length(trim(title)) > 0),
  subject       TEXT,
  stage         TEXT,
  source_note   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  write_version INTEGER NOT NULL DEFAULT 1 CHECK (write_version >= 1)
) STRICT;
CREATE INDEX problems_created ON problems (created_at, id);
CREATE INDEX problems_updated ON problems (updated_at, id);

CREATE TABLE materials (
  id            TEXT PRIMARY KEY NOT NULL,
  title         TEXT CHECK (title IS NULL OR length(trim(title)) > 0),
  subject       TEXT,
  stage         TEXT,
  source_note   TEXT,
  status        TEXT NOT NULL CHECK (status IN ('inbox', 'active')),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT,
  write_version INTEGER NOT NULL DEFAULT 1 CHECK (write_version >= 1)
) STRICT;
CREATE INDEX materials_created ON materials (created_at, id);
CREATE INDEX materials_updated ON materials (updated_at, id);

-- 内容块恰好属于一个题目或一个资料
CREATE TABLE content_blocks (
  id              TEXT PRIMARY KEY NOT NULL,
  problem_id      TEXT REFERENCES problems (id),
  material_id     TEXT REFERENCES materials (id),
  position        INTEGER NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('markdown', 'text', 'image')),
  body            TEXT,
  asset_id        TEXT REFERENCES assets (id),
  remote_image_id TEXT REFERENCES remote_images (id),
  caption         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CHECK ((problem_id IS NULL) <> (material_id IS NULL)),
  CHECK (
    (kind IN ('markdown', 'text') AND body IS NOT NULL AND asset_id IS NULL AND remote_image_id IS NULL AND caption IS NULL)
    OR
    (kind = 'image' AND body IS NULL AND ((asset_id IS NULL) <> (remote_image_id IS NULL)))
  )
) STRICT;
CREATE UNIQUE INDEX content_blocks_problem_pos ON content_blocks (problem_id, position) WHERE problem_id IS NOT NULL;
CREATE UNIQUE INDEX content_blocks_material_pos ON content_blocks (material_id, position) WHERE material_id IS NOT NULL;
CREATE INDEX content_blocks_asset ON content_blocks (asset_id);

CREATE TABLE notes (
  id         TEXT PRIMARY KEY NOT NULL,
  problem_id TEXT NOT NULL REFERENCES problems (id),
  type       TEXT NOT NULL CHECK (type IN ('note', 'answer', 'solution')),
  title      TEXT CHECK (title IS NULL OR length(trim(title)) > 0),
  body_md    TEXT NOT NULL,
  position   INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;
CREATE INDEX notes_problem ON notes (problem_id, position);

CREATE TABLE tags (
  id         TEXT PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 60),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE problem_tags (
  problem_id TEXT NOT NULL REFERENCES problems (id),
  tag_id     TEXT NOT NULL REFERENCES tags (id),
  PRIMARY KEY (problem_id, tag_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX problem_tags_tag ON problem_tags (tag_id);

CREATE TABLE material_tags (
  material_id TEXT NOT NULL REFERENCES materials (id),
  tag_id      TEXT NOT NULL REFERENCES tags (id),
  PRIMARY KEY (material_id, tag_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX material_tags_tag ON material_tags (tag_id);

CREATE TABLE problem_material_links (
  problem_id  TEXT NOT NULL REFERENCES problems (id),
  material_id TEXT NOT NULL REFERENCES materials (id),
  note        TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (problem_id, material_id)
) STRICT;
CREATE INDEX problem_material_links_material ON problem_material_links (material_id);

-- 原始输入：保留收到的原文/原文件/原 URL，编辑不覆盖
CREATE TABLE raw_inputs (
  id                TEXT PRIMARY KEY NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('text', 'file', 'url')),
  text              TEXT,
  asset_id          TEXT REFERENCES assets (id),
  url               TEXT,
  original_filename TEXT,
  problem_id        TEXT REFERENCES problems (id),
  material_id       TEXT REFERENCES materials (id),
  block_id          TEXT,
  captured_at       TEXT NOT NULL,
  CHECK (NOT (problem_id IS NOT NULL AND material_id IS NOT NULL)),
  CHECK (
    (kind = 'text' AND text IS NOT NULL)
    OR (kind = 'file' AND asset_id IS NOT NULL)
    OR (kind = 'url' AND url IS NOT NULL)
  )
) STRICT;
CREATE INDEX raw_inputs_problem ON raw_inputs (problem_id);
CREATE INDEX raw_inputs_material ON raw_inputs (material_id);

-- 可重建的检索投影（派生数据，不进入备份）
CREATE TABLE search_index (
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('problem', 'material')),
  owner_id   TEXT NOT NULL,
  field      TEXT NOT NULL CHECK (field IN ('title', 'content', 'note', 'answer', 'solution', 'tag', 'source')),
  text       TEXT NOT NULL
) STRICT;
CREATE INDEX search_index_owner ON search_index (owner_kind, owner_id);
`;
