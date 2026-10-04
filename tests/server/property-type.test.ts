import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, newId, type TestApp } from '../helpers/server.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

interface Def {
  id: string;
  name: string;
  type: string;
  nested: boolean;
  options: { id: string; path: string; label: string }[];
}

async function create(t: TestApp, body: Record<string, unknown> = {}, kind: 'problems' | 'materials' = 'problems') {
  const res = await t.json('POST', `/api/${kind}`, { id: newId(), blocks: [], ...body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.entity as { id: string; version: number };
}
async function property(t: TestApp, name: string, type: string, extra: Record<string, unknown> = {}): Promise<Def> {
  const r = await t.json('POST', '/api/properties', { id: newId(), name, type, appliesProblem: true, appliesMaterial: true, ...extra });
  expect(r.status).toBe(201);
  return r.body;
}
const def = async (t: TestApp, id: string) => (await t.json('GET', `/api/properties/${id}`)).body as Def;
const valuesOf = async (t: TestApp, id: string, propertyId: string, kind = 'problems') =>
  ((await t.json('GET', `/api/${kind}/${id}`)).body.properties as { propertyId: string }[]).find((v) => v.propertyId === propertyId);
const version = (t: TestApp, id: string) => (t.lib.db.prepare('SELECT write_version AS v FROM problems WHERE id = ?').get(id) as { v: number }).v;
const change = (t: TestApp, id: string, type: string, dryRun = false) => t.json('POST', `/api/properties/${id}/type`, { type, ...(dryRun ? { dryRun } : {}) });

describe('修改属性类型', () => {
  it('文本 → 单选：不同的文字变成选项（不区分大小写），取值改为选项并递增版本；试运行不写入；可以撤销', async () => {
    t = await makeTestApp();
    const p = await property(t, '出处', 'text');
    const a = await create(t, { properties: [{ propertyId: p.id, text: '人教版' }] });
    const b = await create(t, { properties: [{ propertyId: p.id, text: 'PEP' }] });
    const c = await create(t, { properties: [{ propertyId: p.id, text: 'pep' }] }, 'materials');
    await create(t, { properties: [{ propertyId: p.id, text: 'PEP' }] });
    const s = await t.json('POST', '/api/saved-searches', { id: newId(), scope: 'problem', name: '人教', text: '出处:人教' });

    const preview = await change(t, p.id, 'select', true);
    expect(preview.body).toMatchObject({ affectedItems: 4, createdOptions: 2, removedOptions: 0, brokenSearches: 1 });
    expect(preview.body.undoId).toBeUndefined();
    expect((await def(t, p.id)).type).toBe('text');
    expect(version(t, a.id)).toBe(1);

    const r = await change(t, p.id, 'select');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ affectedItems: 4, createdOptions: 2, brokenSearches: 1 });
    const d = await def(t, p.id);
    expect(d.type).toBe('select');
    expect(d.options.map((o) => o.label).sort()).toEqual(['PEP', '人教版'].sort());
    const pep = d.options.find((o) => o.label === 'PEP')!.id;
    expect(await valuesOf(t, b.id, p.id)).toEqual({ propertyId: p.id, optionIds: [pep] });
    expect(await valuesOf(t, c.id, p.id, 'materials')).toEqual({ propertyId: p.id, optionIds: [pep] });
    expect(version(t, a.id)).toBe(2);
    expect((await t.json('GET', `/api/problems?q=${encodeURIComponent('出处:PEP')}`)).body.total).toBe(2);
    const saved = ((await t.json('GET', '/api/saved-searches')).body as { id: string; problems: string[] }[]).find((x) => x.id === s.body.id)!;
    expect(saved.problems.join()).toContain('已改为单选');

    const u = await t.json('POST', `/api/undo/${r.body.undoId}`);
    expect(u.status).toBe(200);
    const back = await def(t, p.id);
    expect(back.type).toBe('text');
    expect(back.options).toEqual([]);
    expect(await valuesOf(t, a.id, p.id)).toEqual({ propertyId: p.id, text: '人教版' });
    expect(version(t, a.id)).toBe(3);
    const restored = ((await t.json('GET', '/api/saved-searches')).body as { id: string; text: string; problems: string[] }[]).find((x) => x.id === s.body.id)!;
    expect(restored).toMatchObject({ text: '出处:人教', problems: [] });
    // 撤销后再转一次：由取值重新建选项（不会撞上撤销时软删除的旧选项）
    expect((await change(t, p.id, 'multiselect')).body).toMatchObject({ createdOptions: 2 });
  });

  it('多选 → 单选：有对象选了多个时整体不做；单选 → 多选不改取值、不递增版本', async () => {
    t = await makeTestApp();
    const p = await property(t, '章节', 'multiselect');
    const ensure = async (path: string) => (await t!.json('POST', `/api/properties/${p.id}/options/ensure-path`, { path })).body.optionId as string;
    const x = await ensure('第一章');
    const y = await ensure('第二章');
    const a = await create(t, { title: '两章都有', properties: [{ propertyId: p.id, optionIds: [x, y] }] });
    const bad = await change(t, p.id, 'select');
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('两章都有');
    expect((await def(t, p.id)).type).toBe('multiselect');

    const cur = await t.json('GET', `/api/problems/${a.id}`);
    await t.json('PUT', `/api/problems/${a.id}`, { expectedVersion: cur.body.version, blocks: [], properties: [{ propertyId: p.id, optionIds: [x] }] });
    const v = version(t, a.id);
    expect((await change(t, p.id, 'select')).body).toMatchObject({ affectedItems: 0, brokenSearches: 0 });
    expect((await change(t, p.id, 'multiselect')).body).toMatchObject({ affectedItems: 0 });
    expect(version(t, a.id)).toBe(v);
  });

  it('分层多选 → 文本：选项写成路径文字（按树的顺序，用“、”连接），选项被删除', async () => {
    t = await makeTestApp();
    const p = await property(t, '知识块', 'multiselect');
    await t.json('PUT', `/api/properties/${p.id}`, { nested: true });
    const ensure = async (path: string) => (await t!.json('POST', `/api/properties/${p.id}/options/ensure-path`, { path })).body.optionId as string;
    const b = await ensure('代数/方程');
    const a = await ensure('代数/函数');
    const g = await ensure('几何');
    const e = await create(t, { properties: [{ propertyId: p.id, optionIds: [g, a, b] }] });
    const r = await change(t, p.id, 'text');
    expect(r.body).toMatchObject({ affectedItems: 1, removedOptions: 4 });
    expect(await valuesOf(t, e.id, p.id)).toEqual({ propertyId: p.id, text: '代数/方程、代数/函数、几何' });
    const d = await def(t, p.id);
    expect(d).toMatchObject({ type: 'text', nested: false, options: [] });
  });

  it('文本 → 数字 / 日期：全部能读出来才转换（全角数字、2024/9/1 这类写法也行）；数字、日期 → 文本', async () => {
    t = await makeTestApp();
    const year = await property(t, '年份', 'text');
    const when = await property(t, '考试', 'text');
    const a = await create(t, { properties: [{ propertyId: year.id, text: '２０２４' }, { propertyId: when.id, text: '2024/9/1' }] });
    const b = await create(t, { properties: [{ propertyId: year.id, text: '约 2023 年' }, { propertyId: when.id, text: '2024-02-30' }] });
    const bad = await change(t, year.id, 'number');
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toContain('约 2023 年');
    expect((await change(t, when.id, 'date')).status).toBe(400);

    let cur = await t.json('GET', `/api/problems/${b.id}`);
    await t.json('PUT', `/api/problems/${b.id}`, {
      expectedVersion: cur.body.version,
      blocks: [],
      properties: [
        { propertyId: year.id, text: '2023' },
        { propertyId: when.id, text: '2024-02-28' },
      ],
    });
    expect((await change(t, year.id, 'number')).body).toMatchObject({ affectedItems: 2 });
    expect(await valuesOf(t, a.id, year.id)).toEqual({ propertyId: year.id, number: 2024 });
    // 已经是规范写法的日期不算改动
    expect((await change(t, when.id, 'date')).body).toMatchObject({ affectedItems: 1 });
    expect(await valuesOf(t, a.id, when.id)).toEqual({ propertyId: when.id, date: '2024-09-01' });
    cur = await t.json('GET', `/api/problems?q=${encodeURIComponent('年份:>=2024')}`);
    expect(cur.body.total).toBe(1);

    expect((await change(t, year.id, 'text')).body).toMatchObject({ affectedItems: 2 });
    expect(await valuesOf(t, a.id, year.id)).toEqual({ propertyId: year.id, text: '2024' });
  });

  it('内置属性、已归档的属性、不支持的组合不能改', async () => {
    t = await makeTestApp();
    const defs = (await t.json('GET', '/api/properties')).body as { id: string; preset: string | null }[];
    const kp = defs.find((d) => d.preset === 'knowledge')!;
    expect((await change(t, kp.id, 'text')).status).toBe(400);
    const flag = await property(t, '重点', 'checkbox');
    expect((await change(t, flag.id, 'text')).status).toBe(400);
    const old = await property(t, '旧属性', 'text');
    await t.json('POST', `/api/properties/${old.id}/archive`);
    expect((await change(t, old.id, 'select')).body.error.message).toContain('取消归档');
  });
});
