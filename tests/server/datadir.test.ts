import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/server/db/migrations.js';
import { openLibrary, type OpenedLibrary } from '../../src/server/library.js';
import { appRoot, resolveDataDir } from '../../src/server/paths.js';
import { makeTempDir, newId } from '../helpers/server.js';

const opened: OpenedLibrary[] = [];
const restorePerms: (() => void)[] = [];
afterEach(() => {
  for (const f of restorePerms.splice(0)) f();
  for (const l of opened.splice(0)) l.close();
});

async function open(dir: string, opts: Parameters<typeof openLibrary>[1] = {}) {
  const lib = await openLibrary(dir, opts);
  opened.push(lib);
  return lib;
}

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('数据目录与数据库', () => {
  it('新目录初始化：目录结构、持久性配置、库 ID', async () => {
    const dir = path.join(await makeTempDir(), 'data');
    const lib = await open(dir);
    expect(lib.state).toBe('new');
    for (const sub of ['assets', 'backups', 'tmp']) expect(fs.statSync(path.join(dir, sub)).isDirectory()).toBe(true);
    expect(lib.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(lib.db.pragma('synchronous', { simple: true })).toBe(2);
    expect(lib.db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(lib.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(lib.db.prepare("SELECT value FROM library_meta WHERE key = 'library_id'").get()).toBeTruthy();
    // 外键与 CHECK 约束生效
    expect(() =>
      lib.db.prepare("INSERT INTO notes (id, problem_id, type, body_md, position, created_at, updated_at) VALUES (?, ?, 'note', '', 0, 'x', 'x')").run(newId(), newId()),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      lib.db.prepare("INSERT INTO problems (id, title, created_at, updated_at) VALUES (?, '  ', 'x', 'x')").run(newId()),
    ).toThrow(/CHECK/);
  });

  it('同一数据目录只允许一个实例；陈旧锁可被接管', async () => {
    const dir = path.join(await makeTempDir(), 'data');
    const lib = await open(dir);
    await expect(openLibrary(dir)).rejects.toMatchObject({ code: 'DATA_DIR_LOCKED' });
    lib.close();
    opened.pop();
    fs.writeFileSync(path.join(dir, 'sworks.lock'), JSON.stringify({ pid: 999999, host: (await import('node:os')).hostname(), startedAt: 'x', purpose: 'server' }));
    const again = await open(dir);
    expect(again.state).toBe('existing');
  });

  it('非空但没有数据库的目录不会被当成新库初始化', async () => {
    const dir = await makeTempDir();
    fs.writeFileSync(path.join(dir, 'important.txt'), 'keep');
    await expect(openLibrary(dir)).rejects.toMatchObject({ code: 'DATA_DIR_INVALID' });
    expect(fs.readdirSync(dir)).toEqual(['important.txt']);
  });

  it('数据库损坏时报错并保留现场，不自动重建', async () => {
    const dir = path.join(await makeTempDir(), 'data');
    const lib = await open(dir);
    lib.close();
    opened.pop();
    const dbFile = path.join(dir, 'db.sqlite3');
    for (const f of ['db.sqlite3-wal', 'db.sqlite3-shm']) fs.rmSync(path.join(dir, f), { force: true });
    const garbage = Buffer.alloc(8192, 0x42);
    fs.writeFileSync(dbFile, garbage);
    await expect(openLibrary(dir)).rejects.toMatchObject({ code: 'DATA_DIR_INVALID' });
    expect(fs.readFileSync(dbFile).equals(garbage)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sworks.lock'))).toBe(false);
  });

  it('数据库版本高于程序时拒绝打开', async () => {
    const dir = path.join(await makeTempDir(), 'data');
    const lib = await open(dir);
    lib.db.pragma('user_version = 99');
    lib.close();
    opened.pop();
    await expect(openLibrary(dir)).rejects.toMatchObject({ code: 'SCHEMA_TOO_NEW' });
  });

  it('模式升级前先做安全备份；备份失败则停止升级，不改动旧库', async () => {
    const dir = path.join(await makeTempDir(), 'data');
    const lib = await open(dir);
    const pid = newId();
    lib.db.prepare("INSERT INTO problems (id, created_at, updated_at) VALUES (?, 'a', 'a')").run(pid);
    lib.close();
    opened.pop();
    const L = LATEST_SCHEMA_VERSION;
    const v2 = [...MIGRATIONS, { version: L + 1, name: 'test', up: (db: Database.Database) => db.exec('ALTER TABLE problems ADD COLUMN extra TEXT') }];

    if (!isRoot) {
      const backups = path.join(dir, 'backups');
      fs.chmodSync(backups, 0o500);
      restorePerms.push(() => fs.chmodSync(backups, 0o755));
      await expect(openLibrary(dir, { migrations: v2 })).rejects.toMatchObject({ code: 'MIGRATION_BACKUP_FAILED' });
      const check = new Database(path.join(dir, 'db.sqlite3'), { readonly: true });
      expect(check.pragma('user_version', { simple: true })).toBe(L);
      check.close();
      for (const f of restorePerms.splice(0)) f();
    }

    const upgraded = await open(dir, { migrations: v2 });
    expect(upgraded.migration).toMatchObject({ from: L, to: L + 1 });
    expect(upgraded.migration.safetyBackup).toMatch(new RegExp(`pre-migration-v${L}-to-v${L + 1}-.*\\.sqlite3$`));
    const snap = new Database(upgraded.migration.safetyBackup!, { readonly: true });
    expect(snap.pragma('user_version', { simple: true })).toBe(L);
    expect(snap.prepare('SELECT id FROM problems').all()).toEqual([{ id: pid }]);
    snap.close();
  });

  it('默认数据目录解析与启动位置无关', () => {
    expect(resolveDataDir(undefined, {})).toBe(path.join(appRoot(), 'sworks-data'));
    expect(resolveDataDir(undefined, { SWORKS_DATA_DIR: '/x/y' })).toBe('/x/y');
    expect(resolveDataDir('rel', {})).toBe(path.resolve('rel'));
    const cwd = process.cwd();
    try {
      process.chdir('/');
      expect(resolveDataDir(undefined, {})).toBe(path.join(appRoot(), 'sworks-data'));
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('server.json（运行中服务的地址，供命令行工具使用）', () => {
  it('监听后写入（仅本人可读写），关闭时删除', async () => {
    const { startServer, serverInfoPath } = await import('../../src/server/server.js');
    const { silentLogger } = await import('../../src/server/context.js');
    const dir = path.join(await makeTempDir(), 'data');
    const s = await startServer({ dataDir: dir, port: 0, webDir: null, log: silentLogger });
    try {
      const file = serverInfoPath(s.library.paths.root);
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(info).toMatchObject({ pid: process.pid, port: s.port, url: s.url, bootId: s.ctx.sse.bootId });
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      const res = await fetch(`${info.url}/api/session`);
      expect(res.status).toBe(200);
    } finally {
      await s.close();
    }
    expect(fs.existsSync(serverInfoPath(dir))).toBe(false);
  });
});
