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
  preset: string | null;
  nested: boolean;
  options: { id: string; label: string; path: string; parentId: string | null }[];
}

async function defs(t: TestApp, all = false): Promise<Def[]> {
  return (await t.json('GET', `/api/properties${all ? '?all=1' : ''}`)).body;
}
async function preset(t: TestApp, p: string): Promise<Def> {
  return (await defs(t)).find((d) => d.preset === p)!;
}
const opt = (d: Def, label: string) => d.options.find((o) => o.label === label)!.id;

async function create(t: TestApp, body: Record<string, unknown> = {}, kind: 'problems' | 'materials' = 'problems') {
  const id = newId();
  const res = await t.json('POST', `/api/${kind}`, { id, blocks: [{ id: newId(), kind: 'markdown', body: '题干' }], ...body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.entity as { id: string; version: number; properties: any[]; blocks: any[] };
}

const version = (t: TestApp, id: string) =>
  (t.lib.db.prepare('SELECT write_version AS v FROM problems WHERE id = ?').get(id) as { v: number }).v;
const blocksOf = (p: { blocks: any[] }) => p.blocks.map((b) => ({ id: b.id, kind: b.kind, body: b.body }));

describe('预置属性与取值', () => {
  it('新库带有题型、难度（有顺序）、考点（层级多选）', async () => {
    t = await makeTestApp();
    const all = await defs(t);
    expect(all.map((d) => [d.name, d.type, d.preset, d.nested])).toEqual([
      ['题型', 'select', 'qtype', false],
      ['难度', 'select', 'difficulty', false],
      ['考点', 'multiselect', 'knowledge', true],
    ]);
    expect((await preset(t, 'difficulty')).options.map((o) => o.label)).toEqual(['容易', '较易', '中档', '较难', '困难']);
  });

  it('保存与读取属性；省略 properties 不改动；没有实际修改的保存不递增版本（顺序无关）', async () => {
    t = await makeTestApp();
    const diff = await preset(t, 'difficulty');
    const kp = await preset(t, 'knowledge');
    const fn = (await t.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: '数学/函数/单调性' })).body.optionId;
    const geo = (await t.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: '数学/几何' })).body.optionId;
    const p = await create(t, {
      properties: [
        { propertyId: diff.id, optionIds: [opt(diff, '较难')] },
        { propertyId: kp.id, optionIds: [geo, fn] },
      ],
    });
    // 多选按树的顺序返回
    expect(p.properties).toEqual([
      { propertyId: diff.id, optionIds: [opt(diff, '较难')] },
      { propertyId: kp.id, optionIds: [fn, geo] },
    ]);
    // 省略 properties：不改动
    let r = await t.json('PUT', `/api/problems/${p.id}`, { expectedVersion: 1, title: '新标题', blocks: blocksOf(p) });
    expect(r.body.entity.properties).toHaveLength(2);
    expect(r.body.entity.version).toBe(2);
    // 顺序不同但内容相同：没有变化
    r = await t.json('PUT', `/api/problems/${p.id}`, {
      expectedVersion: 2,
      title: '新标题',
      blocks: blocksOf(p),
      properties: [
        { propertyId: kp.id, optionIds: [geo, fn] },
        { propertyId: diff.id, optionIds: [opt(diff, '较难')] },
      ],
    });
    expect(r.body.changed).toBe(false);
    expect(version(t, p.id)).toBe(2);
    // 提供 properties 时，没有出现的属性视为清空
    r = await t.json('PUT', `/api/problems/${p.id}`, {
      expectedVersion: 2,
      title: '新标题',
      blocks: blocksOf(p),
      properties: [{ propertyId: kp.id, optionIds: [fn] }],
    });
    expect(r.body.entity.properties).toEqual([{ propertyId: kp.id, optionIds: [fn] }]);
    expect(version(t, p.id)).toBe(3);
  });

  it('校验：单选只能选一个、选项必须属于该属性、属性必须存在、类型不符；不适用的属性取值被忽略', async () => {
    t = await makeTestApp();
    const diff = await preset(t, 'difficulty');
    const qtype = await preset(t, 'qtype');
    const bad = async (properties: unknown[], kind: 'problems' | 'materials' = 'problems') =>
      (await t!.json('POST', `/api/${kind}`, { id: newId(), blocks: [], properties })).status;
    expect(await bad([{ propertyId: diff.id, optionIds: [opt(diff, '容易'), opt(diff, '困难')] }])).toBe(400);
    expect(await bad([{ propertyId: diff.id, optionIds: [opt(qtype, '解答')] }])).toBe(400);
    expect(await bad([{ propertyId: newId(), optionIds: [] }])).toBe(400);
    expect(await bad([{ propertyId: diff.id, text: '中档' }])).toBe(400);
    expect(await bad([{ propertyId: diff.id, optionIds: [] }, { propertyId: diff.id, optionIds: [] }])).toBe(400);
    const m = await create(t, { properties: [{ propertyId: qtype.id, optionIds: [opt(qtype, '解答')] }] }, 'materials');
    expect(m.properties).toEqual([]);
  });

  it('自定义属性：文本、数字、日期、勾选；名称不能与内置字段重名', async () => {
    t = await makeTestApp();
    const mk = async (name: string, type: string) => (await t!.json('POST', '/api/properties', { id: newId(), name, type }));
    const year = (await mk('年份', 'number')).body;
    const region = (await mk('地区', 'text')).body;
    const exam = (await mk('考试日期', 'date')).body;
    const hot = (await mk('常考', 'checkbox')).body;
    expect((await mk('学科', 'text')).status).toBe(400);
    expect((await mk('TAGS', 'text')).status).toBe(400);
    expect((await mk('年份', 'text')).status).toBe(409);
    const p = await create(t, {
      properties: [
        { propertyId: year.id, number: 2024 },
        { propertyId: region.id, text: '  浙江 ' },
        { propertyId: exam.id, date: '2024-06-07' },
        { propertyId: hot.id, checked: true },
      ],
    });
    expect(p.properties).toEqual([
      { propertyId: year.id, number: 2024 },
      { propertyId: region.id, text: '浙江' },
      { propertyId: exam.id, date: '2024-06-07' },
      { propertyId: hot.id, checked: true },
    ]);
    // 检索命中属性文本
    const found = await t.json('GET', `/api/problems?q=${encodeURIComponent('浙江')}`);
    expect(found.body.items[0].hits).toEqual(['property']);
    // 列表显示文字
    expect(found.body.items[0].properties).toContainEqual({ propertyId: year.id, values: ['2024'] });
  });
});

describe('属性筛选、排序与导航', () => {
  it('考点筛选包含子树；同一属性内为“或”；未设置；按难度排序（未设置在最后）', async () => {
    t = await makeTestApp();
    const diff = await preset(t, 'difficulty');
    const kp = await preset(t, 'knowledge');
    const path = async (p: string) => (await t!.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: p })).body.optionId as string;
    const mono = await path('函数/单调性');
    const fn = await path('函数');
    const geo = await path('几何');
    const a = await create(t, { properties: [{ propertyId: kp.id, optionIds: [mono] }, { propertyId: diff.id, optionIds: [opt(diff, '困难')] }] });
    const b = await create(t, { properties: [{ propertyId: kp.id, optionIds: [geo] }, { propertyId: diff.id, optionIds: [opt(diff, '容易')] }] });
    const c = await create(t);
    const q = async (s: string) => ((await t!.json('GET', `/api/problems?${s}`)).body.items as { id: string }[]).map((i) => i.id);
    expect(await q(`prop=${kp.id}:${fn}`)).toEqual([a.id]);
    expect((await q(`prop=${kp.id}:${fn},${geo}`)).sort()).toEqual([a.id, b.id].sort());
    expect(await q(`prop=${kp.id}:__none__`)).toEqual([c.id]);
    expect(await q(`prop=${kp.id}:${fn}&prop=${diff.id}:${opt(diff, '容易')}`)).toEqual([]);
    expect(await q(`sort=prop:${diff.id}`)).toEqual([b.id, a.id, c.id]);
    // fields=ids 同样的排序
    expect((await t.json('GET', `/api/problems?fields=ids&sort=prop:${diff.id}`)).body.ids).toEqual([b.id, a.id, c.id]);
    // 导航计数：父节点按子树中不重复的对象计
    const nav = (await t.json('GET', '/api/nav?collection=problems')).body;
    const kpNav = nav.properties.find((x: any) => x.propertyId === kp.id);
    expect(kpNav.counts[fn]).toBe(1);
    expect(kpNav.counts[mono]).toBe(1);
    expect(kpNav.none).toBe(1);
  });

  it('批量设置属性、追加与移除多选项', async () => {
    t = await makeTestApp();
    const diff = await preset(t, 'difficulty');
    const kp = await preset(t, 'knowledge');
    const x = (await t.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: '数列' })).body.optionId;
    const y = (await t.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: '不等式' })).body.optionId;
    const a = await create(t);
    const b = await create(t, { properties: [{ propertyId: diff.id, optionIds: [opt(diff, '中档')] }] });
    let r = await t.json('POST', '/api/problems/batch', {
      ids: [a.id, b.id],
      action: { op: 'setProperty', propertyId: diff.id, value: { propertyId: diff.id, optionIds: [opt(diff, '中档')] } },
    });
    expect(r.body.changed).toEqual([a.id]);
    r = await t.json('POST', '/api/problems/batch', { ids: [a.id, b.id], action: { op: 'addOptions', propertyId: kp.id, optionIds: [x, y] } });
    expect(r.body.changed.sort()).toEqual([a.id, b.id].sort());
    r = await t.json('POST', '/api/problems/batch', { ids: [a.id], action: { op: 'removeOptions', propertyId: kp.id, optionIds: [x] } });
    expect((await t.json('GET', `/api/problems/${a.id}`)).body.properties).toContainEqual({ propertyId: kp.id, optionIds: [y] });
    r = await t.json('POST', '/api/problems/batch', { ids: [a.id, b.id], action: { op: 'setProperty', propertyId: diff.id, value: null } });
    expect(r.body.changed).toHaveLength(2);
    expect((await t.json('POST', '/api/problems/batch', { ids: [a.id], action: { op: 'addOptions', propertyId: diff.id, optionIds: [opt(diff, '容易')] } })).status).toBe(400);
  });
});

describe('选项管理', () => {
  it('改名只重建检索投影不递增版本；移动带子树；禁止移进自己的下级', async () => {
    t = await makeTestApp();
    const kp = await preset(t, 'knowledge');
    const fn = (await t.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: '函数' })).body.optionId;
    const mono = (await t.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: '函数/单调性' })).body.optionId;
    const alg = (await t.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: '代数' })).body.optionId;
    const p = await create(t, { properties: [{ propertyId: kp.id, optionIds: [mono] }] });
    await t.json('PUT', `/api/property-options/${fn}`, { label: '函数与导数' });
    expect(version(t, p.id)).toBe(1);
    expect((await t.json('GET', `/api/problems?q=${encodeURIComponent('函数与导数/单调性')}`)).body.total).toBe(1);
    const moved = await t.json('POST', `/api/property-options/${fn}/move`, { parentId: alg });
    expect(moved.body.options.find((o: any) => o.id === mono).path).toBe('代数/函数与导数/单调性');
    expect((await t.json('GET', `/api/problems?q=${encodeURIComponent('代数/函数')}`)).body.total).toBe(1);
    expect((await t.json('POST', `/api/property-options/${alg}/move`, { parentId: mono })).status).toBe(400);
    // 同一层级不能重名
    const dup = await t.json('POST', `/api/properties/${kp.id}/options`, { id: newId(), label: '代数', parentId: null });
    expect(dup.status).toBe(409);
  });

  it('删除选项（含子树）移除取值并递增受影响对象；合并选项转移取值与下级', async () => {
    t = await makeTestApp();
    const kp = await preset(t, 'knowledge');
    const ensure = async (path: string) => (await t!.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path })).body.optionId as string;
    const seq = await ensure('数列');
    const seqSum = await ensure('数列/求和');
    const ser = await ensure('级数');
    const serSum = await ensure('级数/求和');
    const serConv = await ensure('级数/收敛');
    const a = await create(t, { properties: [{ propertyId: kp.id, optionIds: [seq, ser] }] });
    const b = await create(t, { properties: [{ propertyId: kp.id, optionIds: [serSum] }] });
    const c = await create(t, { properties: [{ propertyId: kp.id, optionIds: [seqSum] }] });
    const r = await t.json('POST', `/api/property-options/${ser}/merge`, { intoId: seq });
    // a 的“级数”与 b 的“级数/求和”都被合并（同名下级一起合并）
    expect(r.body.affectedItems).toBe(2);
    expect(version(t, a.id)).toBe(2);
    expect(version(t, b.id)).toBe(2);
    expect(version(t, c.id)).toBe(1);
    // a 同时有两者：合并后只剩 seq
    expect((await t.json('GET', `/api/problems/${a.id}`)).body.properties).toEqual([{ propertyId: kp.id, optionIds: [seq] }]);
    // 同名下级“求和”合并；“收敛”移到“数列”下
    const def = (await t.json('GET', `/api/properties/${kp.id}`)).body as Def;
    expect(def.options.map((o) => o.path)).toEqual(['数列', '数列/求和', '数列/收敛']);
    expect((await t.json('GET', `/api/problems/${b.id}`)).body.properties).toEqual([{ propertyId: kp.id, optionIds: [seqSum] }]);
    expect(def.options.find((o) => o.path === '数列/收敛')!.id).toBe(serConv);
    // 删除子树
    const del = await t.json('POST', `/api/property-options/${seq}/delete`);
    expect(del.body).toEqual({ deleted: 3, affectedItems: 3 });
    expect((await t.json('GET', `/api/problems/${c.id}`)).body.properties).toEqual([]);
    expect((await t.json('GET', `/api/problems?q=${encodeURIComponent('数列')}`)).body.total).toBe(0);
  });

  it('大纲导入：缩进、列表符号与标题表示层级；已有选项沿用', async () => {
    t = await makeTestApp();
    const kp = await preset(t, 'knowledge');
    const outline = ['# 数学', '- 函数', '  - 单调性', '  - 奇偶性', '- 数列', '  1. 等差数列', '## 几何', '\t平面几何', '', '# 物理', '* 力学/运动学'].join('\n');
    const r = await t.json('POST', `/api/properties/${kp.id}/import`, { outline });
    expect(r.body).toEqual({ created: 10, existing: 0 });
    const def = (await t.json('GET', `/api/properties/${kp.id}`)).body as Def;
    expect(def.options.map((o) => o.path)).toEqual([
      '数学',
      '数学/函数',
      '数学/函数/单调性',
      '数学/函数/奇偶性',
      '数学/数列',
      '数学/数列/等差数列',
      '数学/几何',
      '数学/几何/平面几何',
      '物理',
      '物理/力学／运动学',
    ]);
    const again = await t.json('POST', `/api/properties/${kp.id}/import`, { outline: '# 数学\n- 函数\n  - 零点' });
    expect(again.body).toEqual({ created: 1, existing: 2 });
  });

  it('归档属性：取值冻结，不出现在返回数据与检索中；预置属性不能归档；取消归档后恢复', async () => {
    t = await makeTestApp();
    const src = (await t.json('POST', '/api/properties', { id: newId(), name: '来源卷', type: 'text' })).body;
    const p = await create(t, { properties: [{ propertyId: src.id, text: '期末卷' }] });
    await t.json('POST', `/api/properties/${src.id}/archive`);
    expect((await t.json('GET', `/api/problems/${p.id}`)).body.properties).toEqual([]);
    expect((await t.json('GET', `/api/problems?q=${encodeURIComponent('期末卷')}`)).body.total).toBe(0);
    expect(version(t, p.id)).toBe(1);
    // 保存时不会清掉冻结的取值
    await t.json('PUT', `/api/problems/${p.id}`, { expectedVersion: 1, blocks: blocksOf(p), properties: [] });
    await t.json('POST', `/api/properties/${src.id}/unarchive`);
    expect((await t.json('GET', `/api/problems/${p.id}`)).body.properties).toEqual([{ propertyId: src.id, text: '期末卷' }]);
    const kp = await preset(t, 'knowledge');
    expect((await t.json('POST', `/api/properties/${kp.id}/archive`)).status).toBe(400);
  });

  it('从资料建题时带上适用于题目的属性', async () => {
    t = await makeTestApp();
    const kp = await preset(t, 'knowledge');
    const x = (await t.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: '概率' })).body.optionId;
    const m = await create(t, { properties: [{ propertyId: kp.id, optionIds: [x] }] }, 'materials');
    const pid = newId();
    const r = await t.json('POST', `/api/materials/${m.id}/derive`, { problemId: pid, blockIds: [m.blocks[0].id] });
    expect(r.body.entity.properties).toEqual([{ propertyId: kp.id, optionIds: [x] }]);
  });
});
