import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { AppError, toAppError } from '../../src/server/errors.js';
import { ERROR_CODES, ERROR_STATUS, isErrorCode } from '../../src/shared/errors.js';
import { makeTestApp } from '../helpers/server.js';

describe('错误码', () => {
  it('数据库原始报错只进日志，对外是中文说明', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE x (id INTEGER PRIMARY KEY, v TEXT NOT NULL UNIQUE)');
    db.prepare("INSERT INTO x (v) VALUES ('a')").run();
    let err: unknown;
    try {
      db.prepare("INSERT INTO x (v) VALUES ('a')").run();
    } catch (e) {
      err = e;
    }
    const e = toAppError(err);
    expect(e.code).toBe('DB_ERROR');
    expect(e.message).toBe('数据库约束冲突，数据未保存');
    expect(e.message).not.toMatch(/UNIQUE|SQLITE|x\.v/);
    expect((e.cause as Error).message).toContain('UNIQUE');
    const busy = toAppError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', name: 'SqliteError' }));
    expect(busy.code).toBe('BUSY');
    expect(toAppError(Object.assign(new Error('disk full'), { code: 'SQLITE_FULL', name: 'SqliteError' })).code).toBe('DISK_WRITE_FAILED');
    db.close();
  });

  it('每个错误码都有状态码；安全中间件的拒绝也在共享的错误码里', async () => {
    for (const c of ERROR_CODES) expect(ERROR_STATUS[c]).toBeGreaterThanOrEqual(400);
    expect(new AppError('UNAUTHORIZED', 'x').status).toBe(401);
    const t = await makeTestApp();
    try {
      const badHost = await t.request('GET', '/api/session', undefined, { host: 'evil.example:4821' });
      const noCsrf = await t.request('POST', '/api/tags/rename', { from: 'a', to: 'b' }, { 'x-sworks-csrf': '' });
      const badOrigin = await t.request('POST', '/api/tags/rename', { from: 'a', to: 'b' }, { origin: 'http://evil.example' });
      const codes = await Promise.all([badHost, noCsrf, badOrigin].map(async (r) => ((await r.json()) as { error: { code: string } }).error.code));
      expect(codes).toEqual(['FORBIDDEN_HOST', 'CSRF', 'FORBIDDEN_ORIGIN']);
      expect(codes.every(isErrorCode)).toBe(true);
      const tooLarge = await t.request('GET', '/api/nope');
      expect(((await tooLarge.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    } finally {
      t.close();
    }
  });
});
