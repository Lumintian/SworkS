# 完整备份格式（当前 v5）

文件名：`SworkS-backup-<YYYYMMDD-HHMMSSZ>.sworks.zip`（标准 ZIP，必要时为 ZIP64）。

完整备份用于无损恢复与迁移。它包含个人笔记、来源 URL 与学生的作答记录，不是公开分享包。

## 包内结构

```text
manifest.json
records.json
README.txt
assets/<sha256>      # 每个不同内容的附件一份，文件名为其 SHA-256（小写十六进制）
```

包内不允许出现其他条目。恢复时会拒绝未知条目、目录穿越路径、绝对路径、符号链接、加密条目、重复条目，以及超出上限的条目数量或解压体积。

## manifest.json

```jsonc
{
  "format": "sworks-backup",          // 格式标识
  "backupSchemaVersion": 5,           // 备份交换格式版本
  "appVersion": "0.1.0",              // 生成备份的程序版本
  "dbSchemaVersion": 5,               // records.json 对应的数据库 schema 版本
  "libraryId": "<uuid>",              // 库 ID（恢复后保持不变）
  "createdAt": "2026-09-25T06:00:00.000Z",
  "counts": { "problems": 12, "notes": 30, ... },   // records.json 中每张表的记录数
  "records": { "path": "records.json", "sha256": "<hex>", "size": 12345 },
  "assets": [ { "path": "assets/<sha256>", "sha256": "<sha256>", "size": 2048 } ],
  "assetTotalBytes": 2048,
  "remoteImages": {
    "total": 3, "archived": 2,
    "unarchived": [ { "url": "https://…", "status": "failed", "errorMessage": "HTTP 404" } ]
  },
  "integrity": {
    "localDataComplete": true,          // 本地数据（记录 + 附件）已完整打包并校验
    "allRemoteImagesArchived": false    // 与上一项分开报告：有远程图片未归档
  }
}
```

manifest 本身不带校验和；它描述的 `records.json` 与每个附件都带 SHA-256 与字节数，恢复时逐项核对。

## records.json

```jsonc
{
  "format": "sworks-records",
  "backupSchemaVersion": 5,
  "dbSchemaVersion": 5,
  "tables": {
    "library_meta": [...], "dict_entries": [...], "assets": [...], "remote_images": [...],
    "problems": [...], "materials": [...], "content_blocks": [...], "notes": [...],
    "tags": [...], "problem_tags": [...], "material_tags": [...],
    "problem_material_links": [...], "raw_inputs": [...],
    "property_defs": [...], "property_options": [...], "property_values": [...],   // v2 起
    "students": [...], "student_attempts": [...],                                  // v3 起
    "saved_searches": [...],                                                       // v4 起
    "lessons": [...], "lesson_items": [...]                                        // v5 起
  }
}
```

- 每张表的记录与对应版本数据库 schema 的列一一对应（列名为 snake_case，见 [schema.md](schema.md)），父表在前。
- 保留全部稳定 ID、顺序（`position`）、时间、软删除状态（`deleted_at`）、收件箱状态、来源关联、原始输入、未归档远程图片记录。
- `search_index` 是可重建的检索投影，不进入备份；恢复后重建。
- `library_meta` 中 `last_backup_*` 属于运行状态、`search_index_version` 描述本机派生数据，都不进入备份。
- 属性选项树（`property_options`）按创建时间排列，子节点可能排在父节点之前；恢复时外键检查推迟到事务提交时。
- `assets[].rel_path` 必须等于 `<sha256 前两位>/<sha256>.<扩展名>`，扩展名由 `mime` 决定；多个附件记录可以共用同一份字节。

## 生成过程

1. 用 SQLite Backup API 把数据库复制为一致快照（不直接复制正在写入的 `db.sqlite3`）。
2. 从快照导出逻辑记录，得到附件清单。
3. 按清单读取不可变的附件文件并核对哈希（文件缺失或损坏则备份失败）。
4. 在 `tmp/` 写出临时 ZIP，用与恢复相同的校验逻辑完整校验。
5. 校验通过后原子移动到 `backups/`，记录“最近一次成功备份时间”。

## 版本

| 备份格式 | 数据库 schema | 表 |
| --- | --- | --- |
| v1 | v1 | 题目、资料、内容块、笔记、标签、来源、附件、原始输入等 13 张表 |
| v2 | v2 | v1 + `property_defs`、`property_options`、`property_values` |
| v3 | v3 | v2 + `students`、`student_attempts` |
| v4 | v4 | v3 + `saved_searches`；`notes` 增加 `seq`，`raw_inputs` 增加 `original_mime`、`original_size`、`original_sha256` |
| v5 | v5 | v4 + `lessons`、`lesson_items` |

各版本的表定义在 `services/backupFormat.ts` 中冻结（`RECORD_TABLES_V1`…），新版本只追加，不改动旧版本的定义。

## 恢复过程与边界

`pnpm restore -- --input <备份> --data-dir <新目录>`

1. 目标目录必须不存在或为空，且没有被服务占用；不支持合并到已有库。
2. 检查格式标识、版本、条目路径、数量与体积、`records.json` 校验和、记录结构与数量、附件清单与记录一致性，并在写出附件时逐个核对哈希。
3. 在目标目录旁的临时目录中：先把新库迁移到**备份对应的 schema 版本**，清空迁移时写入的默认数据（字典、库信息、预置属性），在一个事务里写入记录；再走正常的迁移链升级到当前版本（旧备份由此补上新表与预置属性）。之后检查外键、数量（按备份自身的表集合）、附件哈希与数据库完整性，重建检索投影。
4. 全部通过后才把临时目录发布为目标目录；任何失败都会删除临时目录，不改动其他数据。

版本规则：`backupSchemaVersion` 或 `dbSchemaVersion` 高于程序支持的版本时拒绝恢复并说明原因，不猜测字段含义、不部分导入。旧版本备份（v1–v4）按上面的迁移链恢复；备份格式版本与数据库版本的组合必须是上表中的一行。

未成功归档的远程图片无法通过备份补回：备份只保留 URL 与状态，恢复命令会单独报告。

备份 → 恢复的往返一致性以逻辑数据与原始附件字节为准，不要求两次备份的 ZIP 文件逐字节相同。
