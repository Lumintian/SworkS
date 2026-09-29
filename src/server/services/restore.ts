/**
 * 从完整备份恢复到一个新的空数据目录：
 * 校验 → 在临时目录重建数据库与附件 → 校验引用/数量/哈希 → 全部通过后发布到目标目录。
 * 任何失败都不会改动目标目录以外的数据，也不会留下半成品目标目录。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_LIMITS, type Limits } from '../config.js';
import { integrityCheck, openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrations.js';
import { AppError } from '../errors.js';
import { dirIsEmptyOrMissing, fsyncDir } from '../fsutil.js';
import { dataPaths, LOCK_FILE } from '../paths.js';
import { sha256File } from './assetStore.js';
import { tableOrderFor, validateBackup, type Manifest, type Records } from './backupFormat.js';
import { markSearchIndexCurrent, reindexAll } from './search.js';

export interface RestoreResult {
  dataDir: string;
  manifest: Manifest;
  counts: Record<string, number>;
  assetFiles: number;
}

export async function restoreBackup(
  input: string,
  targetDir: string,
  opts: { limits?: Partial<Limits>; log?: (msg: string) => void } = {},
): Promise<RestoreResult> {
  const log = opts.log ?? (() => {});
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const target = path.resolve(targetDir);
  const inputPath = path.resolve(input);

  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw new AppError('VALIDATION', `找不到备份文件：${inputPath}`);
  }
  if (fs.existsSync(path.join(target, LOCK_FILE))) {
    throw new AppError('RESTORE_TARGET_INVALID', `目标目录正被 SworkS 服务使用，拒绝恢复：${target}`);
  }
  if (!dirIsEmptyOrMissing(target)) {
    throw new AppError('RESTORE_TARGET_INVALID', `目标目录必须不存在或为空目录（不支持合并到现有库）：${target}`);
  }
  const parent = path.dirname(target);
  await fsp.mkdir(parent, { recursive: true });
  const stage = await fsp.mkdtemp(path.join(parent, '.sworks-restore-'));
  const stagePaths = dataPaths(stage);
  try {
    await fsp.mkdir(stagePaths.assets, { recursive: true });
    await fsp.mkdir(stagePaths.backups, { recursive: true });
    await fsp.mkdir(stagePaths.tmp, { recursive: true });
    const incoming = path.join(stage, 'incoming');
    await fsp.mkdir(incoming);

    // 1. 校验格式、版本、路径、数量/体积、校验和，并把附件写入临时目录
    log('校验备份包…');
    const { opened, manifest, records } = await validateBackup(inputPath, limits, (sha) => path.join(incoming, sha));
    opened.close();

    // 2. 放置附件
    log(`写入 ${manifest.assets.length} 个附件文件…`);
    const placed = new Set<string>();
    for (const a of records.tables.assets) {
      if (placed.has(a.rel_path)) continue;
      const dest = path.join(stagePaths.assets, a.rel_path);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(incoming, a.sha256), dest, fs.constants.COPYFILE_EXCL);
      placed.add(a.rel_path);
    }
    await fsp.rm(incoming, { recursive: true, force: true });

    // 3. 重建数据库
    log('重建数据库…');
    const db = openDatabase(stagePaths.db);
    const tables = tableOrderFor(manifest.backupSchemaVersion);
    try {
      // 先建出与备份相同版本的库写入记录，再走正常的迁移链升级到当前版本
      await migrate(db, { backupsDir: stagePaths.backups, tmpDir: stagePaths.tmp, targetVersion: manifest.dbSchemaVersion, safetyBackup: false });
      insertRecords(db, tables, records.tables);
      await migrate(db, { backupsDir: stagePaths.backups, tmpDir: stagePaths.tmp, safetyBackup: false });
      const fkProblems = db.pragma('foreign_key_check') as unknown[];
      if (fkProblems.length > 0) throw new AppError('BACKUP_INVALID', `备份记录存在无效引用（${fkProblems.length} 处）`);
      reindexAll(db);
      // 4. 校验数量、引用与附件哈希（按备份自身的表集合核对）
      for (const t of tables) {
        const n = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        if (n !== manifest.counts[t]) throw new AppError('BACKUP_INVALID', `恢复后 ${t} 数量不一致`);
      }
      // 检索投影刚按当前规则重建：记下版本（运行时标记，不在备份里，所以放在数量核对之后）
      markSearchIndexCurrent(db);
      for (const a of records.tables.assets) {
        const file = path.join(stagePaths.assets, a.rel_path);
        if ((await sha256File(file)) !== a.sha256) throw new AppError('BACKUP_INVALID', `恢复后附件哈希不一致：${a.id}`);
      }
      const problem = integrityCheck(db);
      if (problem) throw new AppError('DB_ERROR', `恢复后数据库完整性检查失败：${problem}`);
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    await fsyncDir(stage);

    // 5. 发布到目标目录
    if (!dirIsEmptyOrMissing(target) || fs.existsSync(path.join(target, LOCK_FILE))) {
      throw new AppError('RESTORE_TARGET_INVALID', `目标目录在恢复过程中被占用或写入：${target}`);
    }
    if (fs.existsSync(target)) await fsp.rmdir(target);
    await fsp.rename(stage, target);
    await fsyncDir(parent);
    const counts: Record<string, number> = {};
    for (const t of tables) counts[t] = (records.tables as Record<string, unknown[]>)[t]!.length;
    return { dataDir: target, manifest, counts, assetFiles: manifest.assets.length };
  } catch (err) {
    await fsp.rm(stage, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}

function insertRecords(db: ReturnType<typeof openDatabase>, tables: string[], records: Records): void {
  try {
    db.transaction(() => {
      // 自引用的树（属性选项）可能子节点先于父节点写入：外键检查推迟到提交时
      db.pragma('defer_foreign_keys = ON');
      // 新库初始化写入的默认字典、库元信息与预置属性等，统一由备份内容替换
      for (const t of [...tables].reverse()) db.prepare(`DELETE FROM ${t}`).run();
      for (const t of tables) {
        const rows = (records as Record<string, Record<string, unknown>[]>)[t] ?? [];
        if (rows.length === 0) continue;
        const cols = Object.keys(rows[0]!);
        const stmt = db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
        for (const row of rows) stmt.run(row);
      }
    })();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('BACKUP_INVALID', `备份记录无法写入：${(err as Error).message}`, { cause: err });
  }
}
