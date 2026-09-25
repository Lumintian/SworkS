# 数据库结构与迁移

SQLite（better-sqlite3），全部表为 `STRICT`。定义见 `src/server/db/schema-v1.ts`，迁移列表见 `src/server/db/migrations.ts`。

## 连接配置

每次打开数据库都会设置并读回校验：

- `foreign_keys = ON`
- `journal_mode = WAL`
- `synchronous = FULL`
- `busy_timeout = 5000`

相关写操作放在同一事务中；网络下载与文件 IO 不放在数据库事务函数内。

## 表

| 表 | 说明 |
| --- | --- |
| `library_meta` | 库 ID、创建时间、最近一次成功备份时间等 |
| `dict_entries` | 学科、学段的简单可扩展字典（初始值 + 用户填写过的值会出现在候选中） |
| `problems` | 题目：可空 `title`（空标题为 NULL，不写入占位）、`subject`、`stage`、`source_note`、时间、`deleted_at`（软删除）、`write_version` |
| `materials` | 资料：与题目类似，另有 `status`（`inbox` 待整理 / `active` 已整理） |
| `content_blocks` | 有序内容块：`markdown` / `text` 存 `body`；`image` 引用 `asset_id` 或 `remote_image_id`（二选一）与可选 `caption`。`CHECK` 保证恰好属于一个题目或一个资料，同一对象内 `position` 唯一 |
| `notes` | 类型化笔记：`note` / `answer` / `solution`，可空标题，`body_md` 为 Markdown 源码，`position` 排序，软删除 |
| `tags`、`problem_tags`、`material_tags` | 标签（名称不区分大小写唯一）及关联 |
| `problem_material_links` | 题目与来源资料的关系及来源说明 |
| `assets` | 附件：稳定 ID、SHA-256、受控相对路径、MIME、大小、原始文件名。字节按哈希复用，但每次输入都有独立记录 |
| `raw_inputs` | 原始输入：粘贴的原文、原文件（asset）、原 URL、采集时间、所属对象与内容块 |
| `remote_images` | 远程图片：URL（唯一）、归档状态（`pending`/`archived`/`failed`）、本地 asset、归档方式（下载/手动补传）、错误信息、尝试次数 |
| `search_index` | 可重建的检索投影（小写化文本 + 字段来源），不进入备份 |

## 约定

- 所有 ID 为客户端或服务端生成的 UUID；创建请求可安全重试（同一 ID 不会产生第二条记录）；恢复时保留原 ID。
- 时间为 UTC ISO-8601 字符串。
- `write_version` 只用于防止陈旧页面覆盖新内容：更新请求必须携带页面加载时的版本，不一致返回 409。题目本身、内容块、所属笔记、标签、来源的任何修改都会递增该题的 `write_version` 并刷新 `updated_at`；没有实际修改的保存不会递增。
- Markdown 源码是权威内容：保存、重排、打开预览都不会改写它。远程图片归档后通过 `remote_images`（URL → 本地 asset）解析显示，源码中的 URL 保持原样。
- 删除题目/资料/笔记为软删除（`deleted_at`），可在回收站恢复；移除内容块不会删除其原始附件文件，目前不做自动垃圾回收。

## 迁移

- 数据库版本记录在 `PRAGMA user_version`。
- 新库（空目录）直接执行全部迁移并写入库元信息。
- 已有库需要升级时，先用 Backup API 在 `backups/` 生成 `pre-migration-v<from>-to-v<to>-<时间>.sqlite3` 并校验；备份失败则停止升级，旧库不变。
- 每个迁移在单独事务中执行；数据库版本高于程序支持的版本时拒绝打开。
- 已发布的迁移不得修改，结构变更须新增迁移，并同步升级备份格式版本与恢复逻辑。
