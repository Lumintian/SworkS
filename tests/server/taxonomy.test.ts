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
  return res.body.entity as { id: string; version: number };
}

const tagsOf = async (t: TestApp, id: string, kind = 'problems') => (await t.json('GET', `/api/${kind}/${id}`)).body.tags as string[];
const version = (t: TestApp, id: string) =>
  (t.lib.db.prepare('SELECT write_version AS v FROM problems WHERE id = ?').get(id) as { v: number }).v;

describe('标签管理（按路径）', () => {
  it('改名整棵子树，递增受影响对象的版本并重建检索投影', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['数学/函数', '易错'] });
    const b = await create(t, { tags: ['数学/函数/单调性'] });
    const c = await create(t, { tags: ['数学/几何'] });
    const res = await t.json('POST', '/api/tags/rename', { from: '数学/函数', to: '数学/函数与导数' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ renamed: 2, merged: 0, affectedItems: 2 });
    expect(await tagsOf(t, a.id)).toEqual(['数学/函数与导数', '易错']);
    expect(await tagsOf(t, b.id)).toEqual(['数学/函数与导数/单调性']);
    expect(version(t, a.id)).toBe(2);
    expect(version(t, c.id)).toBe(1);
    const found = await t.json('GET', `/api/problems?q=${encodeURIComponent('函数与导数')}`);
    expect(found.body.total).toBe(2);
  });

  it('改名撞上已有标签时合并（不区分大小写），挂接不重复', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['Algebra', 'algebra2'] });
    const b = await create(t, { tags: ['algebra2'] });
    const res = await t.json('POST', '/api/tags/rename', { from: 'algebra2', to: 'ALGEBRA' });
    expect(res.body).toMatchObject({ merged: 1 });
    expect(await tagsOf(t, a.id)).toEqual(['Algebra']);
    expect(await tagsOf(t, b.id)).toEqual(['Algebra']);
    const all = (await t.json('GET', '/api/tags?all=1')).body as { name: string }[];
    expect(all.map((x) => x.name)).toEqual(['Algebra']);
  });

  it('移动到上级：子树中间节点与已有标签冲突时也能正确落位', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['a/b/b/c', 'a/b/c', 'a/c'] });
    const res = await t.json('POST', '/api/tags/rename', { from: 'a/b', to: 'a' });
    expect(res.status).toBe(200);
    // a/b/b/c → a/b/c，a/b/c → a/c（与已有 a/c 合并）
    expect((await tagsOf(t, a.id)).sort()).toEqual(['a/b/c', 'a/c']);
  });

  it('禁止移进自己的子树；路径不存在返回 404', async () => {
    t = await makeTestApp();
    await create(t, { tags: ['a/b'] });
    expect((await t.json('POST', '/api/tags/rename', { from: 'a', to: 'a/b/x' })).status).toBe(400);
    expect((await t.json('POST', '/api/tags/rename', { from: 'zzz', to: 'y' })).status).toBe(404);
    // 改名后超长
    expect((await t.json('POST', '/api/tags/rename', { from: 'a', to: 'x'.repeat(59) })).status).toBe(400);
  });

  it('删除标签子树：从题目与资料（含回收站中的）解除挂接，标签行删除', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['来源/2024', '保留'] });
    const m = await create(t, { tags: ['来源'] }, 'materials');
    const trashed = await create(t, { tags: ['来源/2023'] });
    await t.json('DELETE', `/api/problems/${trashed.id}`);
    const res = await t.json('POST', '/api/tags/delete', { path: '来源' });
    expect(res.body).toEqual({ deleted: 3, affectedItems: 3 });
    expect(await tagsOf(t, a.id)).toEqual(['保留']);
    expect(await tagsOf(t, m.id, 'materials')).toEqual([]);
    expect(await tagsOf(t, trashed.id)).toEqual([]);
    expect((await t.json('GET', `/api/problems?q=${encodeURIComponent('来源')}`)).body.total).toBe(0);
  });
});

describe('学科/学段字典管理', () => {
  it('列出候选与使用次数，含未进入字典但在使用的值', async () => {
    t = await makeTestApp();
    await create(t, { subject: '数学' });
    await create(t, { subject: '奥数' });
    const res = await t.json('GET', '/api/dict/manage');
    const math = res.body.subject.find((e: any) => e.value === '数学');
    expect(math).toMatchObject({ inDict: true, problemCount: 1 });
    expect(res.body.subject.at(-1)).toMatchObject({ value: '奥数', inDict: false, problemCount: 1 });
  });

  it('改名同时改写题目与资料并递增版本；合并到已有值；清除', async () => {
    t = await makeTestApp();
    const a = await create(t, { subject: '奥数' });
    const m = await create(t, { subject: '奥数' }, 'materials');
    const r = await t.json('POST', '/api/dict/subject/rename', { from: '奥数', to: '数学' });
    expect(r.body).toEqual({ affectedItems: 2 });
    expect((await t.json('GET', `/api/problems/${a.id}`)).body.subject).toBe('数学');
    expect((await t.json('GET', `/api/materials/${m.id}`)).body.subject).toBe('数学');
    expect(version(t, a.id)).toBe(2);
    const dict = (await t.json('GET', '/api/dict')).body.subjects as string[];
    expect(dict.filter((v) => v === '数学')).toHaveLength(1);
    await t.json('POST', '/api/dict/subject/rename', { from: '数学', to: null });
    expect((await t.json('GET', `/api/problems/${a.id}`)).body.subject).toBeNull();
    expect((await t.json('GET', '/api/dict')).body.subjects).not.toContain('数学');
  });

  it('字典内改名保持位置；排序；仍在使用的值不能直接移除', async () => {
    t = await makeTestApp();
    await create(t, { stage: '高中' });
    await t.json('POST', '/api/dict/stage/rename', { from: '初中', to: '初中（新课标）' });
    let stages = (await t.json('GET', '/api/dict')).body.stages as string[];
    expect(stages.indexOf('初中（新课标）')).toBe(1);
    await t.json('POST', '/api/dict/stage/reorder', { values: ['高中', '小学'] });
    stages = (await t.json('GET', '/api/dict')).body.stages;
    expect(stages.slice(0, 3)).toEqual(['高中', '小学', '初中（新课标）']);
    expect((await t.json('POST', '/api/dict/stage/remove', { value: '高中' })).status).toBe(409);
    expect((await t.json('POST', '/api/dict/stage/remove', { value: '竞赛' })).status).toBe(200);
    expect((await t.json('POST', '/api/dict/stage/add', { value: '竞赛' })).status).toBe(200);
    expect((await t.json('GET', '/api/dict')).body.stages.at(-1)).toBe('竞赛');
    expect((await t.json('POST', '/api/dict/grade/add', { value: 'x' })).status).toBe(404);
  });
});
