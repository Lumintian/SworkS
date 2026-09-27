import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, newId, type TestApp } from '../helpers/server.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

async function create(t: TestApp, body: Record<string, unknown> = {}, kind: 'problems' | 'materials' = 'problems') {
  const id = newId();
  const res = await t.json('POST', `/api/${kind}`, { id, blocks: [], ...body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.entity as { id: string };
}

const ids = (res: { body: { items: { id: string }[] } }) => res.body.items.map((i) => i.id).sort();

describe('导航计数与标签路径筛选', () => {
  it('子树计数按不重复的对象计算；无标签与未设置学科', async () => {
    t = await makeTestApp();
    await create(t, { tags: ['数学', '数学/函数'], subject: '数学' });
    await create(t, { tags: ['数学/函数/单调性'], subject: '数学' });
    await create(t, { tags: ['易错'] });
    await create(t);
    const trashed = await create(t, { tags: ['数学'] });
    await t.json('DELETE', `/api/problems/${trashed.id}`);
    await create(t, { status: 'inbox' }, 'materials');
    const nav = (await t.json('GET', '/api/nav?collection=problems')).body;
    expect(nav.library).toEqual({ problems: 4, materials: 1, inbox: 1 });
    expect(nav.tagTreeCounts['数学']).toBe(2);
    expect(nav.tagTreeCounts['数学/函数']).toBe(2);
    expect(nav.tagTreeCounts['数学/函数/单调性']).toBe(1);
    expect(nav.untagged).toBe(1);
    expect(nav.subjects).toEqual([{ value: '数学', count: 2 }]);
    expect(nav.noSubject).toBe(2);
    expect(nav.tags.find((x: any) => x.name === '数学').count).toBe(1);
  });

  it('tag=路径 展开为子树；多个路径按 AND；大小写与段空白统一', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['数学/函数/单调性', '易错'] });
    const b = await create(t, { tags: ['数学/几何'] });
    const c = await create(t, { tags: ['Physics / Force'] });
    const d = await create(t);
    const q = (s: string) => t!.json('GET', `/api/problems?${s}`);
    expect(ids(await q(`tag=${encodeURIComponent('数学')}`))).toEqual([a.id, b.id].sort());
    expect(ids(await q(`tag=${encodeURIComponent('数学/函数')}&tag=${encodeURIComponent('易错')}`))).toEqual([a.id]);
    expect(ids(await q(`tag=${encodeURIComponent('physics/force')}`))).toEqual([c.id]);
    // 前缀相同但不是子树
    expect((await q(`tag=${encodeURIComponent('数学/函')}`)).body.total).toBe(0);
    expect((await q(`tag=${encodeURIComponent('不存在')}`)).body.total).toBe(0);
    expect(ids(await q('untagged=1'))).toEqual([d.id]);
    expect(ids(await q(`subject=__none__`))).toHaveLength(4);
  });

  it('fields=ids 返回全部符合条件的 ID（不分页），GET 不修改数据', async () => {
    t = await makeTestApp();
    const made: string[] = [];
    for (let i = 0; i < 25; i++) made.push((await create(t, { tags: ['批'] })).id);
    await create(t);
    const res = await t.json('GET', `/api/problems?fields=ids&tag=${encodeURIComponent('批')}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(25);
    expect(res.body.truncated).toBe(false);
    expect([...res.body.ids].sort()).toEqual(made.sort());
  });
});
