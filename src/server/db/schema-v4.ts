/**
 * Schema v4：笔记序号、原始输入的原文件摘要、常用检索；题型预置属性改为分层。
 * 迁移一经发布不得修改。
 */
export const SCHEMA_V4 = `
-- 笔记的可选序号（例如对应第几问）；显示顺序仍由 position 决定
ALTER TABLE notes ADD COLUMN seq INTEGER CHECK (seq IS NULL OR seq BETWEEN 0 AND 999);

-- 收录时做了格式转换的文件：记下原文件的格式、大小与哈希（不再保留原字节）；三列同空同非空
ALTER TABLE raw_inputs ADD COLUMN original_mime TEXT CHECK (original_mime IS NULL OR length(original_mime) BETWEEN 3 AND 100);
ALTER TABLE raw_inputs ADD COLUMN original_size INTEGER CHECK (original_size IS NULL OR original_size >= 0);
ALTER TABLE raw_inputs ADD COLUMN original_sha256 TEXT CHECK (
  (original_sha256 IS NULL OR length(original_sha256) = 64)
  AND ((original_mime IS NULL) = (original_size IS NULL))
  AND ((original_size IS NULL) = (original_sha256 IS NULL))
);

-- 常用检索：query_json 为 {v, text, ast}，ast 中属性与选项用 ID（改名不失效），标签用路径
CREATE TABLE saved_searches (
  id          TEXT PRIMARY KEY NOT NULL,
  scope       TEXT NOT NULL CHECK (scope IN ('problem', 'material')),
  name        TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 60),
  query_json  TEXT NOT NULL CHECK (json_valid(query_json) AND length(query_json) <= 20000),
  sort        TEXT,
  position    INTEGER NOT NULL,
  show_in_nav INTEGER NOT NULL DEFAULT 1 CHECK (show_in_nav IN (0, 1)),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
) STRICT;
CREATE UNIQUE INDEX saved_searches_live_name ON saved_searches (scope, name COLLATE NOCASE) WHERE deleted_at IS NULL;

-- 题型默认分层（现有选项都在顶层，路径不变）
UPDATE property_defs SET nested = 1 WHERE preset = 'qtype' AND type = 'select';
`;
