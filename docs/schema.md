# 数据库结构与迁移

SQLite（better-sqlite3），全部表为 `STRICT`。定义见 `src/server/db/schema-v1.ts`…`schema-v4.ts`，迁移列表见 `src/server/db/migrations.ts`。当前版本为 v4。

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
| `notes` | 类型化笔记：`note` / `answer` / `solution`，可空标题，`body_md` 为 Markdown 源码，`position` 排序，可选序号 `seq`（0–999，v4；只作标注与归位，显示顺序仍由 `position` 决定），软删除 |
| `tags`、`problem_tags`、`material_tags` | 标签（名称不区分大小写唯一）及关联。名称中的 `/` 表示层级（例如 `方法/换元`），层级由名称推导，不单独存储 |
| `problem_material_links` | 题目与来源资料的关系及来源说明 |
| `assets` | 附件：稳定 ID、SHA-256、受控相对路径、MIME、大小、原始文件名。字节按哈希复用，但每次输入都有独立记录 |
| `raw_inputs` | 原始输入：粘贴的原文、原文件（asset）、原 URL、采集时间、所属对象与内容块。v4 起：收录时做了格式转换的文件另记 `original_mime`、`original_size`、`original_sha256`（三列同空同非空），原字节不保留 |
| `remote_images` | 远程图片：URL（唯一）、归档状态（`pending`/`archived`/`failed`）、本地 asset、归档方式（下载/手动补传）、错误信息、尝试次数 |
| `search_index` | 可重建的检索投影（小写化文本 + 字段来源），不进入备份。v2 起 `field` 不再有 CHECK 约束，新增检索字段不必重建表 |
| `property_defs`（v2） | 自定义属性：名称（未归档的不区分大小写唯一）、类型（`text`/`number`/`date`/`checkbox`/`select`/`multiselect`；自定义属性可以在数据管理里改类型，取值跟着转换，见 `shared/constants.ts#PROPERTY_TYPE_CHANGES`；内置属性不能改）、`nested`（选项成树；单选/多选可随时由平改为分层，有下级选项时不能改回；v4 起题型默认分层）、适用于题目/资料、`preset`（`qtype` 题型 / `difficulty` 难度 / `knowledge` 考点）、顺序、是否在导航显示、`archived_at` |
| `property_options`（v2） | 单选/多选属性的选项：`parent_id` 构成树（复合外键保证父节点属于同一属性）、`label`（不含 `/`，同一父节点下未删除的不区分大小写唯一）、`position`、软删除 |
| `property_values`（v2） | 属性取值：恰好属于一个题目或一个资料；`option_id`、`text_value`、`number_value` 三者恰好一个（勾选存 1，日期存文本 `YYYY-MM-DD`）。部分唯一索引保证选项不重复、标量属性每个对象只有一个值 |
| `students`（v3） | 学生：姓名、学段/年级、备注、归档时间、`write_version` |
| `student_attempts`（v3） | 作答流水：学生、题目、作答时间、结果（`correct`/`partial`/`wrong`/`blank`）、主观难度 1–5、用时、备注、软删除 |
| `saved_searches`（v4） | 常用检索：范围（题目/资料）、名称（未删除的同范围内不区分大小写唯一）、`query_json`（`{v, text, ast}`，AST 中属性与选项用 ID、标签用路径）、排序、位置、是否在导航显示、软删除 |

## 约定

- 所有 ID 为客户端或服务端生成的 UUID；创建请求可安全重试（同一 ID 不会产生第二条记录）；恢复时保留原 ID。
- 时间为 UTC ISO-8601 字符串。
- `write_version` 只用于防止陈旧页面覆盖新内容：更新请求必须携带页面加载时的版本，不一致返回 409。题目本身、内容块、所属笔记、标签、来源的任何修改都会递增该题的 `write_version` 并刷新 `updated_at`；没有实际修改的保存不会递增。
- Markdown 源码是权威内容：保存、重排、打开预览都不会改写它。远程图片归档后通过 `remote_images`（URL → 本地 asset）解析显示，源码中的 URL 保持原样。
- 删除题目/资料/笔记为软删除（`deleted_at`），可在回收站恢复；移除内容块不会删除其原始附件文件，目前不做自动垃圾回收。
- 属性选项与作答记录为软删除；属性定义只归档不删除；学生只归档不删除。
- 在数据管理里删除标签：从所有对象（含回收站中的）解除挂接后，删除已没有任何引用的标签行。标签行本身不含内容，这是唯一会物理删除的记录。
- 题目/资料的属性取值属于其内容：保存、批量操作、删除或合并选项、改属性类型时取值写法变了，都会递增 `write_version`；选项改名、移动只重建检索投影。已归档或不再适用的属性，其取值冻结保留。
- 作答记录独立于题目内容：写入作答不改变题目的 `write_version` 与 `updated_at`。

## 迁移

- 数据库版本记录在 `PRAGMA user_version`。
- 新库（空目录）直接执行全部迁移并写入库元信息。
- 已有库需要升级时，先用 Backup API 在 `backups/` 生成 `pre-migration-v<from>-to-v<to>-<时间>.sqlite3` 并校验；备份失败则停止升级，旧库不变。
- 每个迁移在单独事务中执行；数据库版本高于程序支持的版本时拒绝打开。
- 已发布的迁移不得修改，结构变更须新增迁移，并同步升级备份格式版本与恢复逻辑。
- 迁移只执行 SQL 与固定数据，不调用业务代码（例如预置属性直接写在 `schema-v2.ts` 里），保证任何时候从旧版本一路升级的结果都一样。
- `migrate()` 支持 `targetVersion`（恢复旧备份时先建出对应版本的库）与 `safetyBackup: false`（恢复用的临时库不写安全备份）。

| 版本 | 内容 |
| --- | --- |
| v1 | 初始结构 |
| v2 | 自定义属性（预置题型、难度、考点）；`search_index` 换表去掉 `field` 约束 |
| v3 | 学生与作答记录 |
| v4 | `notes.seq`；`raw_inputs` 原文件摘要三列；`saved_searches`；题型预置属性改为分层 |
