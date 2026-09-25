import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DataPaths {
  root: string;
  db: string;
  assets: string;
  backups: string;
  tmp: string;
  lock: string;
}

export const DB_FILE = 'db.sqlite3';
export const LOCK_FILE = 'sworks.lock';

export function dataPaths(root: string): DataPaths {
  const abs = path.resolve(root);
  return {
    root: abs,
    db: path.join(abs, DB_FILE),
    assets: path.join(abs, 'assets'),
    backups: path.join(abs, 'backups'),
    tmp: path.join(abs, 'tmp'),
    lock: path.join(abs, LOCK_FILE),
  };
}

let cachedAppRoot: string | undefined;

/** 程序安装根目录（包含 package.json 的目录），与启动时的工作目录无关。 */
export function appRoot(): string {
  if (cachedAppRoot) return cachedAppRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const name = JSON.parse(fs.readFileSync(pkg, 'utf8')).name;
        if (name === 'sworks') {
          cachedAppRoot = dir;
          return dir;
        }
      } catch {
        // 继续向上查找
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('无法定位 SworkS 程序根目录');
    dir = parent;
  }
}

/**
 * 默认数据目录的固定解析规则：
 * 1. --data-dir 参数；2. 环境变量 SWORKS_DATA_DIR；3. <程序根目录>/sworks-data。
 * 第 3 条与启动位置无关，避免在不同目录启动时悄悄打开另一个空库。
 */
export function resolveDataDir(cliValue: string | undefined, env = process.env): string {
  if (cliValue) return path.resolve(cliValue);
  if (env.SWORKS_DATA_DIR) return path.resolve(env.SWORKS_DATA_DIR);
  return path.join(appRoot(), 'sworks-data');
}

export function webDistDir(): string {
  return path.join(appRoot(), 'dist', 'web');
}
