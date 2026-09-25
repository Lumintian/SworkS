/**
 * 全库备份：SQLite Backup API 取得一致快照 → 从快照导出逻辑记录与附件清单 →
 * 按清单打包不可变附件 → 生成临时包并完整校验 → 原子发布到 backups/。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BackupInfoDTO, BackupResultDTO } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import { openDatabase } from '../db/connection.js';
import { getMeta, setMeta } from '../db/migrations.js';
import { AppError, toAppError } from '../errors.js';
import { fsyncDir, timestampForFile } from '../fsutil.js';
import { sha256File } from './assetStore.js';
import { BACKUP_README, buildManifest, exportRecords, validateBackup, type Manifest } from './backupFormat.js';
import { writeZip, type ZipItem } from './zip.js';

export const BACKUP_NAME_RE = /^SworkS-backup-\d{8}-\d{6}Z(?:-\d+)?\.sworks\.zip$/;

export async function createBackup(ctx: AppContext): Promise<BackupResultDTO> {
  if (ctx.backupState.running) throw new AppError('BUSY', '已有备份正在进行，请稍候');
  ctx.backupState.running = true;
  const work = path.join(ctx.paths.tmp, `backup-${process.pid}-${Date.now()}`);
  try {
    await fsp.mkdir(work, { recursive: true });
    // 1. 一致性快照（Backup API），不直接复制正在写入的数据库文件
    const snapshotPath = path.join(work, 'snapshot.sqlite3');
    await ctx.db.backup(snapshotPath);
    const snap = openDatabase(snapshotPath, { mustExist: true, readonly: true });
    let records;
    try {
      records = exportRecords(snap);
    } finally {
      snap.close();
    }
    // 2. 按快照清单收集附件并校验其哈希
    const bySha = new Map<string, { rel: string; size: number }>();
    for (const a of records.tables.assets) {
      if (!bySha.has(a.sha256)) bySha.set(a.sha256, { rel: a.rel_path, size: a.size });
    }
    const assetEntries: Manifest['assets'] = [];
    const items: ZipItem[] = [];
    for (const [sha, info] of bySha) {
      const file = ctx.store.absolutePath(info.rel);
      let actual: string;
      try {
        actual = await sha256File(file);
      } catch (err) {
        throw new AppError('BACKUP_INVALID', `附件文件缺失，备份中止：${info.rel}`, { cause: err });
      }
      if (actual !== sha) throw new AppError('BACKUP_INVALID', `附件文件已损坏（哈希不符），备份中止：${info.rel}`);
      const size = (await fsp.stat(file)).size;
      assetEntries.push({ path: `assets/${sha}`, sha256: sha, size });
      items.push({ name: `assets/${sha}`, file, compress: false });
    }
    // 3. 生成 records.json 与 manifest
    const recordsBuf = Buffer.from(JSON.stringify(records), 'utf8');
    const recordsSha = createHash('sha256').update(recordsBuf).digest('hex');
    const manifest = buildManifest(records, recordsSha, recordsBuf.length, assetEntries);
    const zipItems: ZipItem[] = [
      { name: 'manifest.json', buffer: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      { name: 'records.json', buffer: recordsBuf },
      { name: 'README.txt', buffer: Buffer.from(BACKUP_README, 'utf8') },
      ...items,
    ];
    // 4. 写临时包并完整校验
    const tmpZip = path.join(work, 'backup.sworks.zip');
    await writeZip(tmpZip, zipItems);
    const verified = await validateBackup(tmpZip, ctx.limits);
    verified.opened.close();
    // 5. 原子发布
    await fsp.mkdir(ctx.paths.backups, { recursive: true });
    const fileName = await uniqueBackupName(ctx.paths.backups);
    const target = path.join(ctx.paths.backups, fileName);
    await fsp.rename(tmpZip, target);
    await fsyncDir(ctx.paths.backups);
    const createdAt = manifest.createdAt;
    setMeta(ctx.db, 'last_backup_at', createdAt);
    setMeta(ctx.db, 'last_backup_file', fileName);
    const size = (await fsp.stat(target)).size;
    return {
      fileName,
      size,
      createdAt,
      counts: manifest.counts,
      assetFiles: assetEntries.length,
      unarchivedRemoteImages: manifest.remoteImages.unarchived,
    };
  } catch (err) {
    throw toAppError(err);
  } finally {
    ctx.backupState.running = false;
    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function uniqueBackupName(dir: string): Promise<string> {
  const base = `SworkS-backup-${timestampForFile()}`;
  for (let i = 0; i < 100; i++) {
    const name = i === 0 ? `${base}.sworks.zip` : `${base}-${i}.sworks.zip`;
    if (!fs.existsSync(path.join(dir, name))) return name;
  }
  throw new AppError('BUSY', '备份文件名冲突，请稍后重试');
}

export async function listBackups(ctx: AppContext): Promise<BackupInfoDTO[]> {
  let names: string[] = [];
  try {
    names = await fsp.readdir(ctx.paths.backups);
  } catch {
    return [];
  }
  const out: BackupInfoDTO[] = [];
  for (const name of names) {
    if (!BACKUP_NAME_RE.test(name)) continue;
    const st = await fsp.stat(path.join(ctx.paths.backups, name));
    out.push({ fileName: name, size: st.size, createdAt: st.mtime.toISOString() });
  }
  return out.sort((a, b) => b.fileName.localeCompare(a.fileName));
}

export function backupFilePath(ctx: AppContext, name: string): string {
  if (!BACKUP_NAME_RE.test(name)) throw new AppError('NOT_FOUND', '备份文件不存在');
  const file = path.join(ctx.paths.backups, name);
  if (!fs.existsSync(file)) throw new AppError('NOT_FOUND', '备份文件不存在');
  return file;
}

export function lastBackupAt(ctx: AppContext): string | null {
  return getMeta(ctx.db, 'last_backup_at');
}
