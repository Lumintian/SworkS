import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { openDatabase, quickCheck, type DB } from './db/connection.js';
import { LATEST_SCHEMA_VERSION, migrate, schemaVersion, type Migration, type MigrationResult } from './db/migrations.js';
import { ensureSearchIndexVersion } from './services/search.js';
import { AppError } from './errors.js';
import { dataPaths, DB_FILE, LOCK_FILE, type DataPaths } from './paths.js';

export type DataDirState = 'new' | 'existing';

/**
 * 判断数据目录状态。只有“不存在”或“空目录”才允许初始化新库；
 * 目录非空却没有数据库时拒绝启动，避免把用户数据当成空库覆盖。
 */
export function inspectDataDir(root: string): DataDirState {
  let st: fs.Stats;
  try {
    st = fs.statSync(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'new';
    throw err;
  }
  if (!st.isDirectory()) throw new AppError('DATA_DIR_INVALID', `数据目录不是文件夹：${root}`);
  const entries = fs.readdirSync(root).filter((e) => e !== LOCK_FILE);
  if (entries.length === 0) return 'new';
  if (entries.includes(DB_FILE)) return 'existing';
  throw new AppError(
    'DATA_DIR_INVALID',
    `数据目录非空但没有 ${DB_FILE}：${root}。为避免覆盖已有文件，拒绝将其初始化为新库。请指定空目录或正确的数据目录。`,
  );
}

interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  purpose: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 同一数据目录只允许一个实例写入。 */
export function acquireLock(paths: DataPaths, purpose: string): () => void {
  fs.mkdirSync(paths.root, { recursive: true });
  const info: LockInfo = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), purpose };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(paths.lock, 'wx');
      fs.writeSync(fd, JSON.stringify(info));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const cur = JSON.parse(fs.readFileSync(paths.lock, 'utf8')) as LockInfo;
          if (cur.pid === process.pid) fs.unlinkSync(paths.lock);
        } catch {
          // 锁文件已不存在
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let existing: LockInfo | null = null;
      try {
        existing = JSON.parse(fs.readFileSync(paths.lock, 'utf8')) as LockInfo;
      } catch {
        existing = null;
      }
      const sameHost = existing?.host === os.hostname();
      if (existing && (!sameHost || processAlive(existing.pid))) {
        throw new AppError(
          'DATA_DIR_LOCKED',
          `数据目录正被另一个 SworkS 进程使用（pid ${existing.pid}，${existing.purpose}，启动于 ${existing.startedAt}）：${paths.root}`,
        );
      }
      // 持锁进程已退出或锁文件内容损坏：视为陈旧锁
      fs.unlinkSync(paths.lock);
    }
  }
  throw new AppError('DATA_DIR_LOCKED', `无法获取数据目录锁：${paths.root}`);
}

export interface OpenedLibrary {
  paths: DataPaths;
  db: DB;
  state: DataDirState;
  migration: MigrationResult;
  releaseLock: () => void;
  close: () => void;
}

/**
 * 打开（或在空目录中初始化）一个库：加锁 → 检查 → 打开数据库 → 完整性快速检查 → 迁移。
 * 已有数据库损坏时报错并保留现场，不自动重建。
 */
export async function openLibrary(
  root: string,
  opts: { purpose?: string; migrations?: Migration[]; log?: (msg: string) => void } = {},
): Promise<OpenedLibrary> {
  const paths = dataPaths(root);
  const state = inspectDataDir(paths.root);
  const releaseLock = acquireLock(paths, opts.purpose ?? 'server');
  let db: DB | undefined;
  try {
    await fsp.mkdir(paths.assets, { recursive: true });
    await fsp.mkdir(paths.backups, { recursive: true });
    await fsp.mkdir(paths.tmp, { recursive: true });
    try {
      db = openDatabase(paths.db, { mustExist: state === 'existing' });
      const problem = quickCheck(db);
      if (problem) throw new Error(problem);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError(
        'DATA_DIR_INVALID',
        `数据库无法打开或已损坏：${paths.db}（${(err as Error).message}）。已保留现场，未做任何修改；请从备份恢复到新目录。`,
        { cause: err },
      );
    }
    const migration = await migrate(db, {
      backupsDir: paths.backups,
      tmpDir: paths.tmp,
      ...(opts.migrations ? { migrations: opts.migrations } : {}),
    });
    // 检索规则变化（或刚升级）时整体重建检索投影；只在结构已是最新版本时做（测试会只迁移到旧版本）
    if (schemaVersion(db) === LATEST_SCHEMA_VERSION) ensureSearchIndexVersion(db, opts.log);
    const opened = db;
    return {
      paths,
      db: opened,
      state,
      migration,
      releaseLock,
      close: () => {
        if (opened.open) opened.close();
        releaseLock();
      },
    };
  } catch (err) {
    if (db?.open) db.close();
    releaseLock();
    throw err;
  }
}
