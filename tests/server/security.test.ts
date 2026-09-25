import { afterEach, describe, expect, it } from 'vitest';
import { HOST, makeTestApp, newId, uploadImage, type TestApp } from '../helpers/server.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

const create = (id: string) => ({ id, blocks: [{ id: newId(), kind: 'markdown', body: 'x' }] });

describe('本地 API 安全边界', () => {
  it('拒绝非本机 Host（DNS 重绑定）', async () => {
    t = await makeTestApp();
    for (const host of ['evil.example.com', 'evil.example.com:4821', '127.0.0.1:9999', '']) {
      const res = await t.request('GET', '/api/session', undefined, { host });
      expect(res.status, host).toBe(403);
    }
    expect((await t.request('GET', '/api/session', undefined, { host: 'localhost:4821' })).status).toBe(200);
  });

  it('修改请求要求同源与 CSRF 令牌；外部网页不能随意修改本地库', async () => {
    t = await makeTestApp();
    const count = () => (t!.lib.db.prepare('SELECT COUNT(*) AS n FROM problems').get() as { n: number }).n;
    // 跨源页面（带 Origin）
    let res = await t.request('POST', '/api/problems', create(newId()), { origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
    // 跨站 Sec-Fetch-Site
    res = await t.request('POST', '/api/problems', create(newId()), { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    // 缺少令牌（例如简单表单提交）
    res = await t.request('POST', '/api/problems', create(newId()), { 'x-sworks-csrf': '' });
    expect(res.status).toBe(403);
    res = await t.request('POST', '/api/problems', create(newId()), { 'x-sworks-csrf': 'wrong' });
    expect(res.status).toBe(403);
    // 预检请求不被允许，且不返回 CORS 头
    res = await t.request('OPTIONS', '/api/problems', undefined, {
      origin: 'https://evil.example.com',
      'access-control-request-method': 'POST',
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(count()).toBe(0);
    // 正常同源请求
    res = await t.request('POST', '/api/problems', create(newId()));
    expect(res.status).toBe(201);
    expect(count()).toBe(1);
  });

  it('GET 不修改数据；删除必须用修改类方法', async () => {
    t = await makeTestApp();
    const id = newId();
    await t.request('POST', '/api/problems', create(id));
    const res = await t.request('GET', `/api/problems/${id}/restore`);
    expect(res.status).toBe(404);
    const del = await t.request('DELETE', `/api/problems/${id}`, undefined, { 'x-sworks-csrf': 'nope' });
    expect(del.status).toBe(403);
    const row = t.lib.db.prepare('SELECT deleted_at FROM problems WHERE id = ?').get(id) as { deleted_at: string | null };
    expect(row.deleted_at).toBeNull();
  });

  it('附件读取使用受控路径，禁止路径穿越与任意文件读取', async () => {
    t = await makeTestApp();
    const up = await uploadImage(t);
    for (const p of [
      '/api/assets/..%2F..%2Fdb.sqlite3',
      '/api/assets/../../db.sqlite3',
      '/api/assets/%2e%2e%2fdb.sqlite3',
      '/api/assets/not-a-uuid',
      `/api/assets/${newId()}`,
      '/api/backups/..%2Fdb.sqlite3',
      '/api/backups/..%2F..%2Fetc%2Fpasswd',
    ]) {
      const res = await t.request('GET', p);
      expect(res.status, p).toBeGreaterThanOrEqual(400);
      const body = Buffer.from(await res.arrayBuffer());
      expect(body.subarray(0, 15).toString('latin1'), p).not.toBe('SQLite format 3');
    }
    const ok = await t.request('GET', `/api/assets/${up.asset.id}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
    expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('会话接口只对本机同源可读', async () => {
    t = await makeTestApp();
    const res = await t.json('GET', '/api/session');
    expect(res.body.csrfToken).toBe(t.ctx.csrfToken);
    expect(res.body.dataDir).toBe(t.lib.paths.root);
    const raw = await t.request('GET', '/api/session', undefined, { host: HOST, origin: 'https://evil.example.com' });
    expect(raw.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('请求数据校验：非法 ID、非法类型、未知字段被拒绝', async () => {
    t = await makeTestApp();
    expect((await t.json('POST', '/api/problems', { id: 'x', blocks: [] })).status).toBe(400);
    expect((await t.json('POST', '/api/problems', { id: newId(), blocks: [{ id: newId(), kind: 'html', body: '<script>' }] })).status).toBe(400);
    expect((await t.json('POST', '/api/problems', { id: newId(), blocks: [], extra: 1 })).status).toBe(400);
    const r = await t.json('POST', '/api/problems', { id: newId(), blocks: [{ id: newId(), kind: 'image', assetId: newId() }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION');
  });
});
