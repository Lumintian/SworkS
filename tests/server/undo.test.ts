import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, newId, type TestApp } from '../helpers/server.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

async function create(t: TestApp, body: Record<string, unknown> = {}, kind: 'problems' | 'materials' = 'problems') {
  const res = await t.json('POST', `/api/${kind}`, { id: newId(), blocks: [], ...body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.entity as { id: string; version: number };
}

const get = async (t: TestApp, id: string, kind = 'problems') => (await t.json('GET', `/api/${kind}/${id}`)).body;
const version = (t: TestApp, id: string) => (t.lib.db.prepare('SELECT write_version AS v FROM problems WHERE id = ?').get(id) as { v: number }).v;
const total = async (t: TestApp, q: string) => (await t.json('GET', `/api/problems?q=${encodeURIComponent(q)}`)).body.total as number;
const savedText = async (t: TestApp, id: string) =>
  ((await t.json('GET', '/api/saved-searches')).body as { id: string; text: string; problems: string[] }[]).find((s) => s.id === id)!;
async function save(t: TestApp, name: string, text: string) {
  const r = await t.json('POST', '/api/saved-searches', { id: newId(), scope: 'problem', name, text });
  expect(r.status).toBe(201);
  return r.body as { id: string };
}

describe('撤销标签操作', () => {
  it('删除标签：挂接（含回收站中的对象）、标签名与常用检索都换回，对象再递增一次版本', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['数学/函数', '易错'] });
    const b = await create(t, { tags: ['数学/函数/单调性'] }, 'materials');
    const gone = await create(t, { tags: ['数学/函数'] });
    await t.request('DELETE', `/api/problems/${gone.id}`);
    const s = await save(t, '函数', '#数学/函数');

    const del = await t.json('POST', '/api/tags/delete-many', { paths: ['数学'] });
    expect(del.body).toMatchObject({ deleted: 2, affectedItems: 3 });
    expect(del.body.undoId).toBeTruthy();
    expect((await get(t, a.id)).tags).toEqual(['易错']);
    expect((await savedText(t, s.id)).problems.join()).toContain('已删除');

    const r = await t.json('POST', `/api/undo/${del.body.undoId}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ label: '删除标签', affectedItems: 3 });
    expect((await get(t, a.id)).tags).toEqual(['数学/函数', '易错']);
    expect((await get(t, b.id, 'materials')).tags).toEqual(['数学/函数/单调性']);
    expect((await get(t, gone.id)).tags).toEqual(['数学/函数']);
    expect(version(t, a.id)).toBe(3);
    expect(await total(t, '#数学/函数')).toBe(1);
    expect(await savedText(t, s.id)).toMatchObject({ text: '#数学/函数', problems: [] });

    // 同一次操作只能撤销一次
    expect((await t.json('POST', `/api/undo/${del.body.undoId}`)).status).toBe(404);
  });

  it('合并：两个标签各自的挂接都换回；改名：没挂这个标签的对象不受影响', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['Algebra', 'algebra2'] });
    const b = await create(t, { tags: ['algebra2'] });
    const c = await create(t, { tags: ['Algebra'] });
    const merged = await t.json('POST', '/api/tags/rename', { from: 'algebra2', to: 'ALGEBRA' });
    expect(merged.body).toMatchObject({ merged: 1 });
    expect((await t.json('POST', `/api/undo/${merged.body.undoId}`)).status).toBe(200);
    expect((await get(t, a.id)).tags).toEqual(['Algebra', 'algebra2']);
    expect((await get(t, b.id)).tags).toEqual(['algebra2']);
    // c 只挂着合并目标：合并与撤销都没有改它
    expect(version(t, c.id)).toBe(1);

    const moved = await t.json('POST', '/api/tags/move', { paths: ['algebra2'], parent: '代数' });
    expect((await get(t, b.id)).tags).toEqual(['代数/algebra2']);
    await t.json('POST', `/api/undo/${moved.body.undoId}`);
    expect((await get(t, b.id)).tags).toEqual(['algebra2']);
    expect(version(t, c.id)).toBe(1);
  });

  it('操作之后又有改动时拒绝撤销，什么都不改', async () => {
    t = await makeTestApp();
    const a = await create(t, { tags: ['函数'] });
    const b = await create(t, { tags: ['函数'] });
    const del = await t.json('POST', '/api/tags/delete-many', { paths: ['函数'] });
    // 期间又新建了同名标签
    const cur = await get(t, a.id);
    await t.json('PUT', `/api/problems/${a.id}`, { expectedVersion: cur.version, blocks: [], tags: ['函数'] });
    const r = await t.json('POST', `/api/undo/${del.body.undoId}`);
    expect(r.status).toBe(409);
    expect((await get(t, b.id)).tags).toEqual([]);

    // 合并之后其中一个对象的挂接又变了
    const c = await create(t, { tags: ['甲', '乙'] });
    const m = await t.json('POST', '/api/tags/merge', { from: ['甲'], to: '乙' });
    const now = await get(t, c.id);
    await t.json('PUT', `/api/problems/${c.id}`, { expectedVersion: now.version, blocks: [], tags: [] });
    expect((await t.json('POST', `/api/undo/${m.body.undoId}`)).status).toBe(409);
    expect((await get(t, c.id)).tags).toEqual([]);
  });

  it('清理未使用的标签可以撤销；没有任何变化的操作不给撤销', async () => {
    t = await makeTestApp();
    const p = await create(t, { tags: ['孤立'] });
    await t.json('PUT', `/api/problems/${p.id}`, { expectedVersion: p.version, blocks: [], tags: [] });
    const tags = (await t.json('GET', '/api/tags/manage')).body.tags as { id: string; name: string }[];
    const r = await t.json('POST', '/api/tags/delete-unused', { ids: tags.map((x) => x.id) });
    expect(r.body.deleted).toBe(1);
    await t.json('POST', `/api/undo/${r.body.undoId}`);
    expect(((await t.json('GET', '/api/tags/manage')).body.tags as { name: string }[]).map((x) => x.name)).toEqual(['孤立']);
    const again = await t.json('POST', '/api/tags/delete-unused', { ids: [newId()] });
    expect(again.body).toEqual({ deleted: 0 });
  });
});

describe('撤销学科/学段操作', () => {
  it('清除与合并：取值（含回收站中的）、候选顺序与常用检索都换回', async () => {
    t = await makeTestApp();
    const before = (await t.json('GET', '/api/dict/manage')).body.subject.map((e: { value: string }) => e.value);
    const a = await create(t, { subject: '数学' });
    const m = await create(t, { subject: '物理' }, 'materials');
    const gone = await create(t, { subject: '数学' });
    await t.request('DELETE', `/api/problems/${gone.id}`);
    const s = await save(t, '数学', '学科:数学');

    const clear = await t.json('POST', '/api/dict/subject/merge', { values: ['数学', '物理'], into: null });
    expect(clear.body).toMatchObject({ affectedItems: 3 });
    const r = await t.json('POST', `/api/undo/${clear.body.undoId}`);
    expect(r.body).toEqual({ label: '学科清除', affectedItems: 3 });
    expect((await get(t, a.id)).subject).toBe('数学');
    expect((await get(t, m.id, 'materials')).subject).toBe('物理');
    expect((await get(t, gone.id)).subject).toBe('数学');
    expect((await t.json('GET', '/api/dict/manage')).body.subject.map((e: { value: string }) => e.value)).toEqual(before);
    expect(await savedText(t, s.id)).toMatchObject({ text: '学科:数学', problems: [] });

    const merge = await t.json('POST', '/api/dict/subject/rename', { from: '物理', to: '数学' });
    await t.json('POST', `/api/undo/${merge.body.undoId}`);
    expect((await get(t, m.id, 'materials')).subject).toBe('物理');
  });
});

describe('撤销选项操作', () => {
  async function knowledge(t: TestApp) {
    return ((await t.json('GET', '/api/properties')).body as { id: string; preset: string; options: { id: string; path: string }[] }[]).find((d) => d.preset === 'knowledge')!;
  }

  it('删除选项（含子树）：选项以原 ID 恢复，取值、检索投影与常用检索都换回', async () => {
    t = await makeTestApp();
    const kp = await knowledge(t);
    const ensure = async (p: string) => (await t!.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: p })).body.optionId as string;
    const fn = await ensure('函数');
    const mono = await ensure('函数/单调性');
    const a = await create(t, { properties: [{ propertyId: kp.id, optionIds: [mono] }] });
    const s = await save(t, '单调', '考点:函数/单调性');
    const del = await t.json('POST', '/api/property-options/delete-many', { ids: [fn] });
    expect(del.body).toMatchObject({ deleted: 2, affectedItems: 1 });
    expect((await get(t, a.id)).properties).toEqual([]);

    const r = await t.json('POST', `/api/undo/${del.body.undoId}`);
    expect(r.body).toEqual({ label: '删除选项', affectedItems: 1 });
    expect((await knowledge(t)).options.map((o) => [o.id, o.path])).toEqual([
      [fn, '函数'],
      [mono, '函数/单调性'],
    ]);
    expect((await get(t, a.id)).properties).toEqual([{ propertyId: kp.id, optionIds: [mono] }]);
    expect(version(t, a.id)).toBe(3);
    expect(await total(t, '单调性')).toBe(1);
    expect(await savedText(t, s.id)).toMatchObject({ text: '考点:函数/单调性', problems: [] });
  });

  it('合并选项：源选项、下级位置、取值与常用检索换回；只是路径变了的对象不递增版本', async () => {
    t = await makeTestApp();
    const kp = await knowledge(t);
    const ensure = async (p: string) => (await t!.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: p })).body.optionId as string;
    const src = await ensure('函数的性质');
    const child = await ensure('函数的性质/奇偶性');
    const dst = await ensure('函数');
    await ensure('函数/单调性');
    const a = await create(t, { properties: [{ propertyId: kp.id, optionIds: [src, dst] }] });
    const b = await create(t, { properties: [{ propertyId: kp.id, optionIds: [child] }] });
    const s = await save(t, '性质', '考点:函数的性质');
    const before = (await knowledge(t)).options.map((o) => o.path);

    const m = await t.json('POST', '/api/property-options/merge-many', { ids: [src], intoId: dst });
    expect(m.body).toMatchObject({ merged: 1, affectedItems: 1 });
    expect(version(t, b.id)).toBe(1);
    expect(await total(t, '函数/奇偶性')).toBe(1);

    const r = await t.json('POST', `/api/undo/${m.body.undoId}`);
    expect(r.body).toEqual({ label: '合并选项', affectedItems: 1 });
    expect((await knowledge(t)).options.map((o) => o.path)).toEqual(before);
    expect(((await get(t, a.id)).properties[0].optionIds as string[]).sort()).toEqual([src, dst].sort());
    expect(version(t, a.id)).toBe(3);
    expect(version(t, b.id)).toBe(1);
    expect(await total(t, '函数的性质/奇偶性')).toBe(1);
    expect(await savedText(t, s.id)).toMatchObject({ text: '考点:函数的性质' });
  });

  it('期间新建了同名选项时拒绝撤销', async () => {
    t = await makeTestApp();
    const kp = await knowledge(t);
    const ensure = async (p: string) => (await t!.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: p })).body.optionId as string;
    const x = await ensure('数列');
    const del = await t.json('POST', '/api/property-options/delete-many', { ids: [x] });
    await ensure('数列');
    const r = await t.json('POST', `/api/undo/${del.body.undoId}`);
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('同名');
    expect((await knowledge(t)).options.filter((o) => o.path === '数列')).toHaveLength(1);
  });
});
