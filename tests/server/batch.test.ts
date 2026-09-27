import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, newId, type TestApp } from '../helpers/server.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

async function create(t: TestApp, body: Record<string, unknown> = {}, kind: 'problems' | 'materials' = 'problems') {
  const id = newId();
  const res = await t.json('POST', `/api/${kind}`, { id, blocks: [{ id: newId(), kind: 'markdown', body: '题干' }], ...body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.entity as { id: string; version: number; tags: string[]; blocks: any[]; updatedAt: string };
}

const version = (t: TestApp, id: string, table = 'problems') =>
  (t.lib.db.prepare(`SELECT write_version AS v FROM ${table} WHERE id = ?`).get(id) as { v: number }).v;

describe('批量操作', () => {
  it('批量加标签只递增真正变化的对象，并重建检索投影', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['函数'] });
    const b = await create(t);
    const res = await t.json('POST', '/api/problems/batch', { ids: [a.id, b.id], action: { op: 'addTags', names: ['函数'] } });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual([b.id]);
    expect(res.body.unchanged).toBe(1);
    expect(res.body.tagIds).toHaveLength(1);
    expect(version(t, a.id)).toBe(1);
    expect(version(t, b.id)).toBe(2);
    // 检索投影随之更新
    const found = await t.json('GET', `/api/problems?q=${encodeURIComponent('函数')}`);
    expect(found.body.total).toBe(2);
  });

  it('批量操作后，旧编辑页保存得到 409，旧标签不会被写回', async () => {
    t = await makeTestApp();
    const p = await create(t, { tags: ['旧标签'] });
    const tagId = (await t.json('GET', '/api/tags')).body[0].id;
    const res = await t.json('POST', '/api/problems/batch', { ids: [p.id], action: { op: 'removeTags', tagIds: [tagId] } });
    expect(res.body.changed).toEqual([p.id]);
    // 旧页面仍带着 version 1 与旧标签
    const stale = await t.json('PUT', `/api/problems/${p.id}`, {
      expectedVersion: p.version,
      tags: ['旧标签'],
      blocks: p.blocks.map((b) => ({ id: b.id, kind: b.kind, body: b.body })),
    });
    expect(stale.status).toBe(409);
    expect((await t.json('GET', `/api/problems/${p.id}`)).body.tags).toEqual([]);
  });

  it('设置学科/学段：相同值不递增；null 清除', async () => {
    t = await makeTestApp();
    const a = await create(t, { subject: '数学' });
    const b = await create(t, { subject: '物理' });
    const r1 = await t.json('POST', '/api/problems/batch', { ids: [a.id, b.id], action: { op: 'setSubject', value: '数学' } });
    expect(r1.body.changed).toEqual([b.id]);
    const r2 = await t.json('POST', '/api/problems/batch', { ids: [a.id, b.id], action: { op: 'setStage', value: '  高中 ' } });
    expect(r2.body.changed.sort()).toEqual([a.id, b.id].sort());
    expect((await t.json('GET', `/api/problems/${a.id}`)).body.stage).toBe('高中');
    await t.json('POST', '/api/problems/batch', { ids: [a.id], action: { op: 'setSubject', value: null } });
    expect((await t.json('GET', `/api/problems/${a.id}`)).body.subject).toBeNull();
  });

  it('移到回收站与恢复；回收站中的对象跳过其他操作', async () => {
    t = await makeTestApp();
    const a = await create(t);
    const b = await create(t);
    const trash = await t.json('POST', '/api/problems/batch', { ids: [a.id, b.id], action: { op: 'trash' } });
    expect(trash.body.changed.sort()).toEqual([a.id, b.id].sort());
    expect((await t.json('GET', '/api/problems')).body.total).toBe(0);
    const tag = await t.json('POST', '/api/problems/batch', { ids: [a.id], action: { op: 'addTags', names: ['x'] } });
    expect(tag.body).toMatchObject({ changed: [], skipped: 1 });
    const restore = await t.json('POST', '/api/problems/batch', { ids: [a.id], action: { op: 'restore' } });
    expect(restore.body.changed).toEqual([a.id]);
    expect((await t.json('GET', '/api/problems')).body.total).toBe(1);
  });

  it('资料可以批量改整理状态；题目不能', async () => {
    t = await makeTestApp();
    const m = await create(t, { status: 'inbox' }, 'materials');
    const res = await t.json('POST', '/api/materials/batch', { ids: [m.id], action: { op: 'setStatus', status: 'active' } });
    expect(res.body.changed).toEqual([m.id]);
    expect(version(t, m.id, 'materials')).toBe(2);
    expect((await t.json('GET', '/api/materials?status=inbox')).body.total).toBe(0);
    const p = await create(t);
    expect((await t.json('POST', '/api/problems/batch', { ids: [p.id], action: { op: 'setStatus', status: 'active' } })).status).toBe(400);
  });

  it('有 ID 不存在时整批失败，不做部分修改', async () => {
    t = await makeTestApp();
    const a = await create(t);
    const res = await t.json('POST', '/api/problems/batch', { ids: [a.id, newId()], action: { op: 'addTags', names: ['x'] } });
    expect(res.status).toBe(404);
    expect(version(t, a.id)).toBe(1);
    expect((await t.json('GET', `/api/problems/${a.id}`)).body.tags).toEqual([]);
  });

  it('请求校验：未知操作、空 ID 列表被拒绝', async () => {
    t = await makeTestApp();
    const a = await create(t);
    expect((await t.json('POST', '/api/problems/batch', { ids: [a.id], action: { op: 'drop' } })).status).toBe(400);
    expect((await t.json('POST', '/api/problems/batch', { ids: [], action: { op: 'trash' } })).status).toBe(400);
  });
});
