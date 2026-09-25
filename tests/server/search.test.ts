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
