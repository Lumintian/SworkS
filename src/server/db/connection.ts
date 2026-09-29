import Database from 'better-sqlite3';
import { normText } from '../../shared/query/normalize.js';
import { AppError } from '../errors.js';

export type DB = Database.Database;

export interface OpenOptions {
  mustExist?: boolean;
  readonly?: boolean;
}

/**
 * 打开数据库并应用持久性配置：外键、WAL、synchronous=FULL、busy_timeout。
 * 配置写入后读回校验，确保驱动实际生效。
 */
export function openDatabase(file: string, opts: OpenOptions = {}): DB {
  const db = new Database(file, {
    fileMustExist: opts.mustExist ?? false,
    readonly: opts.readonly ?? false,
    timeout: 5000,
  });
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    // 临时表（变更记录）只放内存
    db.pragma('temp_store = MEMORY');
    if (!opts.readonly) {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
    }
    verifyPragmas(db, !opts.readonly);
    // 检索用的规范化（NFKC + 小写 + 折叠空白），与检索投影、查询词一致；文本属性的子串匹配用它
    db.function('sworks_norm', { deterministic: true }, (v: unknown) => (typeof v === 'string' ? normText(v) : null));
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

function verifyPragmas(db: DB, writable: boolean): void {
  const fk = db.pragma('foreign_keys', { simple: true });
  const busy = db.pragma('busy_timeout', { simple: true });
  const problems: string[] = [];
  if (fk !== 1) problems.push(`foreign_keys=${String(fk)}`);
  if (busy !== 5000) problems.push(`busy_timeout=${String(busy)}`);
  if (writable) {
    const jm = db.pragma('journal_mode', { simple: true });
    const sync = db.pragma('synchronous', { simple: true });
    if (jm !== 'wal') problems.push(`journal_mode=${String(jm)}`);
    // synchronous: 0=OFF 1=NORMAL 2=FULL 3=EXTRA
    if (sync !== 2) problems.push(`synchronous=${String(sync)}`);
  }
  if (problems.length > 0) {
    throw new AppError('DB_ERROR', `数据库持久性配置未生效：${problems.join(', ')}`);
  }
}

/** 数据库完整性快速检查；返回 null 表示正常，否则返回问题描述。 */
export function quickCheck(db: DB): string | null {
  const rows = db.pragma('quick_check') as { quick_check: string }[];
  const msgs = rows.map((r) => r.quick_check);
  return msgs.length === 1 && msgs[0] === 'ok' ? null : msgs.slice(0, 5).join('; ');
}

export function integrityCheck(db: DB): string | null {
  const rows = db.pragma('integrity_check') as { integrity_check: string }[];
  const msgs = rows.map((r) => r.integrity_check);
  return msgs.length === 1 && msgs[0] === 'ok' ? null : msgs.slice(0, 5).join('; ');
}

export function nowIso(): string {
  return new Date().toISOString();
}
