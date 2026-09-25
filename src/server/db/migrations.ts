import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { APP_VERSION, DEFAULT_STAGES, DEFAULT_SUBJECTS } from '../../shared/constants.js';
import { AppError } from '../errors.js';
import { fsyncDir, fsyncFile, timestampForFile } from '../fsutil.js';
import { integrityCheck, nowIso, type DB } from './connection.js';
import { SCHEMA_V1 } from './schema-v1.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: DB) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: (db) => {
      db.exec(SCHEMA_V1);
      const insert = db.prepare('INSERT INTO dict_entries (kind, value, position) VALUES (?, ?, ?)');
      DEFAULT_SUBJECTS.forEach((v, i) => insert.run('subject', v, i));
      DEFAULT_STAGES.forEach((v, i) => insert.run('stage', v, i));
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export interface MigrationResult {
  from: number;
  to: number;
  safetyBackup: string | null;
}

export function schemaVersion(db: DB): number {
  return db.pragma('user_version', { simple: true }) as number;
}

/**
 * 把数据库升级到最新 schema。
 * 已有数据的库在升级前先用 SQLite Backup API 生成安全备份并校验；备份失败则停止升级，不改动原库。
 */
export async function migrate(
  db: DB,
  opts: { backupsDir: string; tmpDir: string; migrations?: Migration[] },
): Promise<MigrationResult> {
  const migrations = opts.migrations ?? MIGRATIONS;
  const latest = migrations[migrations.length - 1]!.version;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new AppError(
      'SCHEMA_TOO_NEW',
      `数据库 schema 版本 v${current} 高于本程序支持的 v${latest}，请使用更新版本的 SworkS 打开。`,
    );
  }
  if (current === latest) return { from: current, to: current, safetyBackup: null };

  let safetyBackup: string | null = null;
  if (current > 0) {
    safetyBackup = await safetyBackupBeforeMigration(db, current, latest, opts.backupsDir, opts.tmpDir);
  }

  for (const m of migrations) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    })();
  }
  if (current === 0) initLibraryMeta(db);
  return { from: current, to: latest, safetyBackup };
}

function initLibraryMeta(db: DB): void {
  const insert = db.prepare('INSERT OR IGNORE INTO library_meta (key, value) VALUES (?, ?)');
  db.transaction(() => {
    insert.run('library_id', randomUUID());
    insert.run('created_at', nowIso());
    insert.run('created_by_app_version', APP_VERSION);
  })();
}

async function safetyBackupBeforeMigration(
  db: DB,
  from: number,
  to: number,
  backupsDir: string,
  tmpDir: string,
): Promise<string> {
  const name = `pre-migration-v${from}-to-v${to}-${timestampForFile()}.sqlite3`;
  const target = path.join(backupsDir, name);
  const tmp = path.join(tmpDir, `${name}.part`);
  try {
    await fsp.mkdir(backupsDir, { recursive: true });
    await fsp.mkdir(tmpDir, { recursive: true });
    await db.backup(tmp);
    await fsyncFile(tmp);
    const check = new Database(tmp, { readonly: true, fileMustExist: true });
    try {
      const problem = integrityCheck(check);
      if (problem) throw new Error(`安全备份校验失败：${problem}`);
      const v = check.pragma('user_version', { simple: true });
      if (v !== from) throw new Error(`安全备份版本不一致：${String(v)}`);
    } finally {
      check.close();
    }
    await fsp.rename(tmp, target);
    await fsyncDir(backupsDir);
    return target;
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw new AppError('MIGRATION_BACKUP_FAILED', `升级前安全备份失败，已停止升级，原数据库未改动：${(err as Error).message}`, {
      cause: err,
    });
  }
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM library_meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare(
    'INSERT INTO library_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}
