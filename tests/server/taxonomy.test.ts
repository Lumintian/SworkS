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

describe('标签树的计数与清理', () => {
  it('每个节点按不重复的对象计数（含子孙），回收站中的单独计数；列出没人用的标签行', async () => {
    t = await makeTestApp();
    await create(t, { tags: ['几何/圆', '几何/三角形'] });
    await create(t, { tags: ['几何/圆'] }, 'materials');
    const gone = await create(t, { tags: ['几何/圆', '函数'] });
    await t.request('DELETE', `/api/problems/${gone.id}`);
    // 只剩一个没人用的标签行
    const lonely = await create(t, { tags: ['孤立'] });
    await t.json('PUT', `/api/problems/${lonely.id}`, { expectedVersion: lonely.version, blocks: [], tags: [] });
    const r = (await t.json('GET', '/api/tags/manage')).body as { tags: { id: string; name: string; used: boolean }[]; usage: Record<string, unknown> };
    expect(r.usage['几何']).toEqual({ problems: 1, materials: 1, trashed: 1 });
    expect(r.usage['几何/三角形']).toEqual({ problems: 1, materials: 0, trashed: 0 });
    expect(r.usage['函数']).toEqual({ problems: 0, materials: 0, trashed: 1 });
    expect(r.usage['孤立']).toBeUndefined();
    const unused = r.tags.filter((x) => !x.used);
    expect(unused.map((x) => x.name)).toEqual(['孤立']);

    // 清理：只删仍然没人用的行（期间被用上的跳过）
    const used = r.tags.find((x) => x.name === '函数')!;
    const del = await t.json('POST', '/api/tags/delete-unused', { ids: [unused[0]!.id, used.id] });
    expect(del.body).toEqual({ deleted: 1 });
    const names = ((await t.json('GET', '/api/tags/manage')).body.tags as { name: string }[]).map((x) => x.name).sort();
    expect(names).toEqual(['函数', '几何/三角形', '几何/圆'].sort());
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

  it('只有回收站中的对象在用的值：单独计数，清除时同样改写它们，之后可以移出候选', async () => {
    t = await makeTestApp();
    await t.json('POST', '/api/dict/subject/add', { value: '天文' });
    const p = await create(t, { subject: '天文' });
    await t.request('DELETE', `/api/problems/${p.id}`);
    const entry = (await t.json('GET', '/api/dict/manage')).body.subject.find((e: { value: string }) => e.value === '天文');
    expect(entry).toEqual({ value: '天文', inDict: true, problemCount: 0, materialCount: 0, trashedCount: 1 });
    const bad = await t.json('POST', '/api/dict/subject/remove-many', { values: ['天文'] });
    expect(bad.status).toBe(409);
    expect(bad.body.error.message).toContain('回收站');
    const r = await t.json('POST', '/api/dict/subject/merge', { values: ['天文'], into: null });
    expect(r.body).toMatchObject({ affectedItems: 1 });
    expect((t.lib.db.prepare('SELECT subject FROM problems WHERE id = ?').get(p.id) as { subject: string | null }).subject).toBeNull();
    const after = (await t.json('GET', '/api/dict/manage')).body.subject.map((e: { value: string }) => e.value);
    expect(after).not.toContain('天文');
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

describe('数据管理的多选批量操作', () => {
  it('一次删除多个标签：父子同时选中按父级处理；被多个所选标签命中的对象只递增一次；全部不存在时 404', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['数学/函数', '易错', '待讲评'] });
    const b = await create(t, { tags: ['数学/函数/单调性'] });
    const c = await create(t, { tags: ['保留'] });
    const res = await t.json('POST', '/api/tags/delete-many', { paths: ['数学/函数/单调性', '数学/函数', '易错', '待讲评', '不存在'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: 4, affectedItems: 2 });
    expect(await tagsOf(t, a.id)).toEqual([]);
    expect(await tagsOf(t, b.id)).toEqual([]);
    expect(await tagsOf(t, c.id)).toEqual(['保留']);
    // a 命中三个标签，只递增一次
    expect(version(t, a.id)).toBe(2);
    expect(version(t, b.id)).toBe(2);
    expect(version(t, c.id)).toBe(1);
    expect((await t.json('POST', '/api/tags/delete-many', { paths: ['不存在'] })).status).toBe(404);
  });

  it('多个标签合并到同一目标：各自子树落到目标之下；重名合并；对象只递增一次；不能合并到自己的下级', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['旧/甲', '另一个'] });
    const b = await create(t, { tags: ['另一个/子'] });
    const res = await t.json('POST', '/api/tags/merge', { from: ['旧/甲', '另一个'], to: '新' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ affectedItems: 2 });
    expect(await tagsOf(t, a.id)).toEqual(['新']);
    expect(await tagsOf(t, b.id)).toEqual(['新/子']);
    expect(version(t, a.id)).toBe(2);
    expect((await t.json('POST', '/api/tags/merge', { from: ['新'], to: '新/子/更深' })).status).toBe(400);
  });

  it('多个标签移到另一个标签下（拖动）：保留末级名称，子树跟随；移回顶层；不能移进自己的下级', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['换元', '配方/完全平方'] });
    let r = await t.json('POST', '/api/tags/move', { paths: ['换元', '配方'], parent: '方法' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ renamed: 2, affectedItems: 1 });
    expect(await tagsOf(t, a.id)).toEqual(['方法/换元', '方法/配方/完全平方']);
    expect(version(t, a.id)).toBe(2);
    r = await t.json('POST', '/api/tags/move', { paths: ['方法/换元'], parent: null });
    expect(await tagsOf(t, a.id)).toEqual(['换元', '方法/配方/完全平方']);
    expect((await t.json('POST', '/api/tags/move', { paths: ['方法'], parent: '方法/配方' })).status).toBe(400);
  });

  it('学科多值合并与清除一次完成；移出候选时任何一个仍在使用就整体不做', async () => {
    t = await makeTestApp();
    const a = await create(t, { subject: '数学' });
    const b = await create(t, { subject: '奥数' });
    const m = await create(t, { subject: '数学' }, 'materials');
    await t.json('POST', '/api/dict/subject/add', { value: '竞赛' });
    let r = await t.json('POST', '/api/dict/subject/merge', { values: ['奥数', '竞赛'], into: '数学' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ affectedItems: 1 });
    expect((await t.json('GET', `/api/problems/${b.id}`)).body.subject).toBe('数学');
    r = await t.json('POST', '/api/dict/subject/merge', { values: ['数学'], into: null });
    expect(r.body).toEqual({ affectedItems: 3 });
    expect((await t.json('GET', `/api/materials/${m.id}`)).body.subject).toBeNull();
    expect(version(t, a.id)).toBe(2);
    // 移出候选：物理仍在使用的值会整体失败
    await create(t, { subject: '物理' });
    const bad = await t.json('POST', '/api/dict/subject/remove-many', { values: ['化学', '物理'] });
    expect(bad.status).toBe(409);
    expect(bad.body.error.message).toContain('物理');
    const dict = (await t.json('GET', '/api/dict/manage')).body.subject.map((e: { value: string }) => e.value);
    expect(dict).toContain('化学');
    const ok = await t.json('POST', '/api/dict/subject/remove-many', { values: ['化学', '生物'] });
    expect(ok.status).toBe(200);
    expect(ok.body.subject.map((e: { value: string }) => e.value)).not.toContain('化学');
  });
});
