import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, newId, type TestApp } from '../helpers/server.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

async function create(t: TestApp, body: Record<string, unknown>) {
  const id = newId();
  const res = await t.json('POST', '/api/problems', { id, ...body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  await new Promise((r) => setTimeout(r, 3));
  return res.body.entity as { id: string; version: number; blocks: any[]; notes: any[] };
}

const ids = (res: { body: { items: { id: string }[] } }) => res.body.items.map((i) => i.id);

describe('检索、筛选与排序', () => {
  it('只出现在 Note 中的中文关键词也能找到题目，并提示命中位置', async () => {
    t = await makeTestApp();
    const p = await create(t, {
      blocks: [{ id: newId(), kind: 'markdown', body: '求函数的最小值' }],
      notes: [{ id: newId(), type: 'answer', bodyMd: '> [!answer]- 展开\n> 利用均值不等式' }],
    });
    await create(t, { blocks: [{ id: newId(), kind: 'markdown', body: '无关题目' }] });
    const res = await t.json('GET', `/api/problems?q=${encodeURIComponent('均值不等')}`);
    expect(ids(res)).toEqual([p.id]);
    expect(res.body.items[0].hits).toEqual(['answer']);
  });

  it('多个关键词按 AND；英文大小写不敏感；中文连续子串', async () => {
    t = await makeTestApp();
    const a = await create(t, {
      title: 'Vieta 定理应用',
      blocks: [{ id: newId(), kind: 'text', body: '二次方程根与系数' }],
      notes: [{ id: newId(), type: 'solution', bodyMd: '韦达' }],
    });
    await create(t, { title: '另一道 vieta 题', blocks: [] });
    expect(ids(await t.json('GET', `/api/problems?q=${encodeURIComponent('VIETA 根与系')}`))).toEqual([a.id]);
    expect(ids(await t.json('GET', `/api/problems?q=${encodeURIComponent('vieta 韦达')}`))).toEqual([a.id]);
    expect((await t.json('GET', `/api/problems?q=vieta`)).body.total).toBe(2);
    // 用户输入不会被当作通配符或 SQL
    expect((await t.json('GET', `/api/problems?q=${encodeURIComponent("%' OR 1=1 --")}`)).body.total).toBe(0);
    expect((await t.json('GET', `/api/problems?q=_`)).body.total).toBe(0);
  });

  it('学科、学段、多标签与关键词组合筛选；多标签按 AND', async () => {
    t = await makeTestApp();
    const a = await create(t, { subject: '数学', stage: '高中', tags: ['函数', '导数'], blocks: [{ id: newId(), kind: 'markdown', body: '单调性' }] });
    const b = await create(t, { subject: '数学', stage: '高中', tags: ['函数'], blocks: [{ id: newId(), kind: 'markdown', body: '单调性' }] });
    await create(t, { subject: '物理', stage: '高中', tags: ['函数', '导数'], blocks: [{ id: newId(), kind: 'markdown', body: '单调性' }] });
    await create(t, { subject: '数学', stage: '初中', tags: ['函数', '导数'], blocks: [{ id: newId(), kind: 'markdown', body: '单调性' }] });
    const tags = (await t.json('GET', '/api/tags')).body as { id: string; name: string }[];
    const fn = tags.find((x) => x.name === '函数')!.id;
    const dv = tags.find((x) => x.name === '导数')!.id;
    const q = (s: string) => t!.json('GET', `/api/problems?${s}`);
    expect(ids(await q(`subject=${encodeURIComponent('数学')}&stage=${encodeURIComponent('高中')}&tags=${fn},${dv}`))).toEqual([a.id]);
    expect(ids(await q(`subject=${encodeURIComponent('数学')}&stage=${encodeURIComponent('高中')}&tags=${fn}`)).sort()).toEqual([a.id, b.id].sort());
    expect((await q(`tags=${fn},${dv}&q=${encodeURIComponent('单调')}`)).body.total).toBe(3);
    expect((await q(`tags=${fn},${dv}&q=${encodeURIComponent('不存在')}`)).body.total).toBe(0);
  });

  it('默认最近添加降序；最近修改包含笔记修改', async () => {
    t = await makeTestApp();
    const first = await create(t, { blocks: [{ id: newId(), kind: 'markdown', body: '第一题' }] });
    const second = await create(t, { blocks: [{ id: newId(), kind: 'markdown', body: '第二题' }] });
    expect(ids(await t.json('GET', '/api/problems'))).toEqual([second.id, first.id]);
    // 只给第一题加一条笔记
    await t.json('PUT', `/api/problems/${first.id}`, {
      expectedVersion: first.version,
      blocks: first.blocks.map((b) => ({ id: b.id, kind: b.kind, body: b.body })),
      notes: [{ id: newId(), type: 'note', bodyMd: '新增笔记' }],
    });
    expect(ids(await t.json('GET', '/api/problems?sort=updated'))).toEqual([first.id, second.id]);
    expect(ids(await t.json('GET', '/api/problems?sort=created'))).toEqual([second.id, first.id]);
  });

  it('已删除内容与已删除笔记默认排除；分页', async () => {
    t = await makeTestApp();
    const a = await create(t, { blocks: [{ id: newId(), kind: 'markdown', body: '关键字甲' }] });
    const noteId = newId();
    const b = await create(t, { blocks: [], notes: [{ id: noteId, type: 'note', bodyMd: '关键字乙' }] });
    await t.request('DELETE', `/api/problems/${a.id}`);
    expect((await t.json('GET', `/api/problems?q=${encodeURIComponent('关键字甲')}`)).body.total).toBe(0);
    await t.json('PUT', `/api/problems/${b.id}`, { expectedVersion: b.version, blocks: [], notes: [] });
    expect((await t.json('GET', `/api/problems?q=${encodeURIComponent('关键字乙')}`)).body.total).toBe(0);
    for (let i = 0; i < 5; i++) await create(t, { blocks: [{ id: newId(), kind: 'markdown', body: `分页${i}` }] });
    const page1 = await t.json('GET', '/api/problems?limit=2&offset=0');
    const page2 = await t.json('GET', '/api/problems?limit=2&offset=2');
    expect(page1.body.total).toBe(6);
    expect(page1.body.items).toHaveLength(2);
    expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
  });

  it('搜索覆盖标签名、来源备注与图片说明；不把来源资料全文隐式并入题目', async () => {
    t = await makeTestApp();
    const mid = newId();
    await t.json('POST', '/api/materials', { id: mid, blocks: [{ id: newId(), kind: 'markdown', body: '资料独有词汇' }] });
    const p = await create(t, {
      tags: ['圆锥曲线'],
      sourceNote: '2025 某地模拟卷',
      blocks: [{ id: newId(), kind: 'markdown', body: '题干' }],
      sources: [{ materialId: mid, note: '第二页' }],
    });
    const q = (s: string) => t!.json('GET', `/api/problems?q=${encodeURIComponent(s)}`);
    expect(ids(await q('圆锥'))).toEqual([p.id]);
    expect((await q('圆锥')).body.items[0].hits).toEqual(['tag']);
    expect(ids(await q('模拟卷'))).toEqual([p.id]);
    expect(ids(await q('第二页'))).toEqual([p.id]);
    expect((await q('资料独有')).body.total).toBe(0);
    expect((await t.json('GET', `/api/materials?q=${encodeURIComponent('资料独有')}`)).body.total).toBe(1);
  });

  it('收件箱是资料状态视图', async () => {
    t = await makeTestApp();
    const inbox = newId();
    const active = newId();
    await t.json('POST', '/api/materials', { id: inbox, status: 'inbox', blocks: [] });
    await t.json('POST', '/api/materials', { id: active, status: 'active', blocks: [] });
    expect(ids(await t.json('GET', '/api/materials?status=inbox'))).toEqual([inbox]);
    expect((await t.json('GET', '/api/materials')).body.total).toBe(2);
  });
});

describe('查询语言', () => {
  const q = (t: TestApp, query: string, extra = '') => t.json('GET', `/api/problems?q=${encodeURIComponent(query)}${extra}`);
  async function props(t: TestApp) {
    return (await t.json('GET', '/api/properties')).body as { id: string; name: string; preset: string | null; options: { id: string; path: string }[] }[];
  }
  async function newProp(t: TestApp, name: string, type: string) {
    const id = newId();
    const r = await t.json('POST', '/api/properties', { id, name, type, nested: false, appliesProblem: true, appliesMaterial: true });
    expect(r.status).toBe(201);
    return id;
  }

  it('字段范围、跨换行的短语、全角输入经 NFKC 命中、两个字的中文词', async () => {
    t = await makeTestApp();
    const a = await create(t, { title: '二次函数', blocks: [{ id: newId(), kind: 'markdown', body: '求 ＡＢＣ 的面积\n\n对称  轴' }] });
    const b = await create(t, { title: '其他', blocks: [{ id: newId(), kind: 'markdown', body: '二次函数的图像' }] });
    expect(ids(await q(t, '标题:二次')).sort()).toEqual([a.id]);
    expect(ids(await q(t, '二次')).sort()).toEqual([a.id, b.id].sort());
    expect(ids(await q(t, '"对称 轴"'))).toEqual([a.id]);
    expect(ids(await q(t, 'abc'))).toEqual([a.id]);
    expect(ids(await q(t, 'ＡＢＣ'))).toEqual([a.id]);
    expect(ids(await q(t, '面积'))).toEqual([a.id]);
  });

  it('取反包含未设置的值；OR；范围:；有:答案 / -有:答案', async () => {
    t = await makeTestApp();
    const math = await create(t, { subject: '数学', blocks: [{ id: newId(), kind: 'markdown', body: '甲' }], notes: [{ id: newId(), type: 'answer', bodyMd: '答案里的乙' }] });
    const phys = await create(t, { subject: '物理', title: '乙', blocks: [{ id: newId(), kind: 'markdown', body: '丙' }] });
    const none = await create(t, { blocks: [{ id: newId(), kind: 'markdown', body: '丁' }] });
    expect(ids(await q(t, '-学科:数学')).sort()).toEqual([phys.id, none.id].sort());
    expect(ids(await q(t, '甲 OR 丙')).sort()).toEqual([math.id, phys.id].sort());
    expect(ids(await q(t, '乙 范围:标题'))).toEqual([phys.id]);
    expect(ids(await q(t, '乙 范围:答案'))).toEqual([math.id]);
    expect(ids(await q(t, '有:答案'))).toEqual([math.id]);
    expect(ids(await q(t, '-有:答案')).sort()).toEqual([phys.id, none.id].sort());
    expect(ids(await q(t, '学科:无'))).toEqual([none.id]);
  });

  it('属性：有序单选比较、分层末级名简写与重名提示、未知选项 0 条并报错', async () => {
    t = await makeTestApp();
    const all = await props(t);
    const diff = all.find((d) => d.preset === 'difficulty')!;
    const qt = all.find((d) => d.preset === 'qtype')!;
    const opt = (d: typeof diff, p: string) => d.options.find((o) => o.path === p)!.id;
    const ensure = async (p: string) => (await t!.json('POST', `/api/properties/${qt.id}/options/ensure-path`, { path: p })).body.optionId as string;
    const enSel = await ensure('英语/选择');
    await ensure('通用/选择');
    const hard = await create(t, { properties: [{ propertyId: diff.id, optionIds: [opt(diff, '较难')] }, { propertyId: qt.id, optionIds: [enSel] }], blocks: [] });
    const easy = await create(t, { properties: [{ propertyId: diff.id, optionIds: [opt(diff, '容易')] }], blocks: [] });
    expect(ids(await q(t, '难度:>=较难'))).toEqual([hard.id]);
    expect(ids(await q(t, '难度:<较难'))).toEqual([easy.id]);
    const amb = await q(t, '题型:选择');
    expect(ids(amb)).toEqual([hard.id]);
    expect(amb.body.diagnostics.some((d: { severity: string }) => d.severity === 'warning')).toBe(true);
    const bad = await q(t, '题型:阅读理解');
    expect(bad.body.total).toBe(0);
    expect(bad.body.diagnostics[0].severity).toBe('error');
    expect(ids(await q(t, '题型:英语'))).toEqual([hard.id]);
  });

  it('数字、日期、文本、勾选属性', async () => {
    t = await makeTestApp();
    const year = await newProp(t, '年份', 'number');
    const when = await newProp(t, '考试日期', 'date');
    const memo = await newProp(t, '出处', 'text');
    const flag = await newProp(t, '重点', 'checkbox');
    const a = await create(t, { properties: [{ propertyId: year, number: 2021 }, { propertyId: when, date: '2026-06-07' }, { propertyId: memo, text: '人教版 必修一' }, { propertyId: flag, checked: true }], blocks: [] });
    const b = await create(t, { properties: [{ propertyId: year, number: 2024 }], blocks: [] });
    expect(ids(await q(t, '年份:>=2022'))).toEqual([b.id]);
    expect(ids(await q(t, '年份:2020..2021'))).toEqual([a.id]);
    expect(ids(await q(t, '考试日期:2026-06'))).toEqual([a.id]);
    expect(ids(await q(t, '考试日期:<2026-06-07'))).toEqual([]);
    expect(ids(await q(t, '出处:人教版'))).toEqual([a.id]);
    expect(ids(await q(t, '出处:ＲＥＮ'))).toEqual([]);
    expect(ids(await q(t, '出处:无'))).toEqual([b.id]);
    expect(ids(await q(t, '重点:是'))).toEqual([a.id]);
    expect(ids(await q(t, '重点:否'))).toEqual([b.id]);
  });

  it('日期按本机时区的自然日换算', async () => {
    t = await makeTestApp();
    const p = await create(t, { blocks: [] });
    const { listEntities } = await import('../../src/server/services/search.js');
    const created = new Date(p.id && (await t.json('GET', `/api/problems/${p.id}`)).body.createdAt);
    const day = (d: number) => new Date(created.getFullYear(), created.getMonth(), created.getDate() + d, 12);
    const count = (s: string, now: Date) => listEntities(t!.lib.db, 'problem', { q: s, now }).total;
    expect(count('创建:今天', day(0))).toBe(1);
    expect(count('创建:昨天', day(1))).toBe(1);
    expect(count('创建:今天', day(1))).toBe(0);
    expect(count('创建:7天', day(6))).toBe(1);
    expect(count('创建:7天', day(7))).toBe(0);
    const ymd = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`;
    expect(count(`创建:${ymd}`, day(0))).toBe(1);
    expect(count(`创建:<${ymd}`, day(0))).toBe(0);
    expect(count(`修改:>=${ymd}`, day(0))).toBe(1);
  });

  it('学生：名字/状态；第一个学生条件作为按学生查看的上下文', async () => {
    t = await makeTestApp();
    const a = await create(t, { blocks: [] });
    const b = await create(t, { blocks: [] });
    const sid = newId();
    await t.json('POST', '/api/students', { id: sid, name: '小明' });
    await t.json('POST', '/api/attempts', { id: newId(), studentId: sid, problemId: a.id, result: 'wrong' });
    await t.json('POST', '/api/attempts', { id: newId(), studentId: sid, problemId: b.id, result: 'correct' });
    const r = await q(t, '学生:小明/错过');
    expect(ids(r)).toEqual([a.id]);
    expect(r.body.studentId).toBe(sid);
    expect(r.body.items[0].attempt).toMatchObject({ count: 1, wrong: 1 });
    expect(ids(await q(t, '学生:小明/最近错'))).toEqual([a.id]);
    expect(ids(await q(t, '-学生:小明/最近错')).sort()).toEqual([b.id]);
  });

  it('相关度：标题命中排在正文命中之前；自由词缺省按相关度，显式排序照常', async () => {
    t = await makeTestApp();
    // 标题命中的先建：按相关度它在前，按创建时间它在后
    const title = await create(t, { title: '抛物线', blocks: [] });
    const body = await create(t, { title: '其他', blocks: [{ id: newId(), kind: 'markdown', body: '讲的是抛物线' }] });
    const r = await q(t, '抛物线');
    expect(r.body.sortApplied).toBe('relevance');
    expect(ids(r)).toEqual([title.id, body.id]);
    const byTime = await q(t, '抛物线', '&sort=created');
    expect(byTime.body.sortApplied).toBe('created');
    expect(ids(byTime)).toEqual([body.id, title.id]);
    expect((await t.json('GET', '/api/problems')).body.sortApplied).toBe('created');
  });

  it('命中片段：区间对应原文，前后留上下文并折叠空白', async () => {
    t = await makeTestApp();
    const long = `${'前文'.repeat(40)}\n\n关键  结论：${'后文'.repeat(40)}`;
    await create(t, { title: '片段', blocks: [{ id: newId(), kind: 'markdown', body: long }], notes: [{ id: newId(), type: 'solution', bodyMd: '另一个 关键 点' }] });
    const r = await q(t, '关键');
    const snippets = r.body.items[0].snippets as { field: string; text: string; ranges: [number, number][] }[];
    expect(snippets.length).toBeLessThanOrEqual(2);
    for (const s of snippets) for (const [a, b] of s.ranges) expect(s.text.slice(a, b)).toBe('关键');
    const content = snippets.find((s) => s.field === 'content')!;
    expect(content.text.startsWith('…')).toBe(true);
    expect(content.text.endsWith('…')).toBe(true);
    expect(content.text).toContain('关键 结论');
  });

  it('旧的筛选参数与 q 取“且”', async () => {
    t = await makeTestApp();
    const a = await create(t, { subject: '数学', tags: ['函数'], blocks: [{ id: newId(), kind: 'markdown', body: '单调' }] });
    await create(t, { subject: '物理', tags: ['函数'], blocks: [{ id: newId(), kind: 'markdown', body: '单调' }] });
    expect(ids(await q(t, '单调', `&subject=${encodeURIComponent('数学')}`))).toEqual([a.id]);
    expect(ids(await q(t, '学科:数学', `&tag=${encodeURIComponent('函数')}`))).toEqual([a.id]);
    expect((await q(t, '学科:数学', `&subject=${encodeURIComponent('物理')}`)).body.total).toBe(0);
  });

  it('检索规则版本变化时打开库会整体重建投影', async () => {
    t = await makeTestApp();
    const p = await create(t, { title: 'ＦＵＬＬ', blocks: [] });
    const db = t.lib.db;
    // 模拟旧版本的投影（只小写，没有 NFKC）
    db.prepare("UPDATE search_index SET text = 'ｆｕｌｌ' WHERE owner_id = ?").run(p.id);
    db.prepare("UPDATE library_meta SET value = '1' WHERE key = 'search_index_version'").run();
    expect((await q(t, 'full')).body.total).toBe(0);
    const { ensureSearchIndexVersion } = await import('../../src/server/services/search.js');
    expect(ensureSearchIndexVersion(db)).toBe(true);
    expect(ensureSearchIndexVersion(db)).toBe(false);
    expect(ids(await q(t, 'full'))).toEqual([p.id]);
  });
});
