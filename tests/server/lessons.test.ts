import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, newId, type TestApp } from '../helpers/server.js';
import { readSse, type SseReader } from '../helpers/sse.js';

let t: TestApp | undefined;
const readers: SseReader[] = [];
afterEach(async () => {
  for (const r of readers.splice(0)) await r.close();
  t?.close();
  t = undefined;
});

async function problem(t: TestApp, title: string | null = null) {
  const id = newId();
  const res = await t.json('POST', '/api/problems', { id, title, blocks: [{ id: newId(), kind: 'markdown', body: `题干 ${id.slice(0, 4)}` }] });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.entity as { id: string; version: number };
}

async function lesson(t: TestApp, body: Record<string, unknown>) {
  const id = newId();
  const res = await t.json('POST', '/api/lessons', { id, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.entity as { id: string; version: number; items: { problemId: string; note: string | null }[] };
}

const problemVersion = (t: TestApp, id: string) =>
  t.lib.db.prepare('SELECT write_version AS v, updated_at FROM problems WHERE id = ?').get(id) as { v: number; updated_at: string };

const items = (ids: string[]) => ids.map((problemId) => ({ problemId }));

describe('教案的保存', () => {
  it('新建按客户端 ID 幂等；按给定顺序引用题目，带题目当前的标题与摘要', async () => {
    t = await makeTestApp();
    const a = await problem(t, '第一题');
    const b = await problem(t);
    const id = newId();
    const body = { id, title: ' 二次函数 · 第 3 讲 ', note: '先复习', items: [{ problemId: b.id, note: '  从图像引入 ' }, { problemId: a.id }] };
    const first = await t.json('POST', '/api/lessons', body);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ created: true, changed: true });
    const again = await t.json('POST', '/api/lessons', body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: false, changed: false });
    expect(t.lib.db.prepare('SELECT COUNT(*) AS n FROM lessons').get()).toEqual({ n: 1 });

    const got = (await t.json('GET', `/api/lessons/${id}`)).body;
    expect(got).toMatchObject({ id, title: '二次函数 · 第 3 讲', note: '先复习', version: 1, deletedAt: null });
    expect(got.items).toEqual([
      { problemId: b.id, note: '从图像引入', title: null, summary: expect.stringContaining('题干'), subject: null, stage: null, deleted: false },
      { problemId: a.id, note: null, title: '第一题', summary: expect.stringContaining('题干'), subject: null, stage: null, deleted: false },
    ]);
  });

  it('更新要带版本：版本不符返回 409；没有变化的保存不递增版本；重排、讲解要点、标题的修改都会递增', async () => {
    t = await makeTestApp();
    const a = await problem(t);
    const b = await problem(t);
    const l = await lesson(t, { title: '讲义', items: items([a.id, b.id]) });
    const put = (expectedVersion: number, body: Record<string, unknown>) => t!.json('PUT', `/api/lessons/${l.id}`, { title: '讲义', items: items([a.id, b.id]), ...body, expectedVersion });

    const same = await put(1, {});
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ changed: false, entity: { version: 1 } });

    const reordered = await put(1, { items: items([b.id, a.id]) });
    expect(reordered.body).toMatchObject({ changed: true, entity: { version: 2 } });
    expect(reordered.body.entity.items.map((i: any) => i.problemId)).toEqual([b.id, a.id]);

    const stale = await put(1, { title: '旧页面的标题' });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatchObject({ code: 'CONFLICT', details: { currentVersion: 2, expectedVersion: 1 } });
    expect((await t.json('GET', `/api/lessons/${l.id}`)).body.title).toBe('讲义');

    const noted = await put(2, { items: [{ problemId: b.id, note: '重点' }, { problemId: a.id }] });
    expect(noted.body).toMatchObject({ changed: true, entity: { version: 3 } });
    const renamed = await put(3, { title: '新标题', items: [{ problemId: b.id, note: '重点' }, { problemId: a.id }] });
    expect(renamed.body).toMatchObject({ changed: true, entity: { version: 4, title: '新标题' } });

    // 移除一道题
    const removed = await put(4, { title: '新标题', items: [{ problemId: a.id }] });
    expect(removed.body.entity.items.map((i: any) => i.problemId)).toEqual([a.id]);
    expect(removed.body.entity.version).toBe(5);
  });

  it('教案与题目的版本互不影响', async () => {
    t = await makeTestApp();
    const a = await problem(t);
    const before = problemVersion(t, a.id);
    const l = await lesson(t, { items: items([a.id]) });
    await t.json('PUT', `/api/lessons/${l.id}`, { expectedVersion: 1, items: [{ problemId: a.id, note: '讲解' }] });
    await t.json('POST', `/api/lessons/${l.id}/items`, { problemIds: [(await problem(t)).id] });
    expect(problemVersion(t, a.id)).toEqual(before);

    const edited = await t.json('PUT', `/api/problems/${a.id}`, { expectedVersion: a.version, title: '改了标题', blocks: [] });
    expect(edited.status).toBe(200);
    const got = (await t.json('GET', `/api/lessons/${l.id}`)).body;
    expect(got.version).toBe(3);
    // 按引用：看到的是题目的新标题
    expect(got.items[0].title).toBe('改了标题');
  });

  it('校验：同一道题只能出现一次；题目必须存在；回收站中的题不能新加入，已有的引用保留', async () => {
    t = await makeTestApp();
    const a = await problem(t);
    const b = await problem(t);
    const dup = await t.json('POST', '/api/lessons', { id: newId(), items: items([a.id, a.id]) });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('只能出现一次');
    const missing = await t.json('POST', '/api/lessons', { id: newId(), items: items([newId()]) });
    expect(missing.status).toBe(400);
    expect(t.lib.db.prepare('SELECT COUNT(*) AS n FROM lessons').get()).toEqual({ n: 0 });

    const l = await lesson(t, { items: items([a.id]) });
    expect((await t.request('DELETE', `/api/problems/${b.id}`)).status).toBe(200);
    const addTrashed = await t.json('PUT', `/api/lessons/${l.id}`, { expectedVersion: 1, items: items([a.id, b.id]) });
    expect(addTrashed.status).toBe(400);
    expect(addTrashed.body.error.message).toContain('回收站');

    // 已在教案里的题进了回收站：引用保留并标出，教案照常保存
    expect((await t.request('DELETE', `/api/problems/${a.id}`)).status).toBe(200);
    const got = (await t.json('GET', `/api/lessons/${l.id}`)).body;
    expect(got.items).toEqual([expect.objectContaining({ problemId: a.id, deleted: true })]);
    const save = await t.json('PUT', `/api/lessons/${l.id}`, { expectedVersion: 1, title: '照常保存', items: items([a.id]) });
    expect(save.status).toBe(200);
  });
});

describe('加到已有教案', () => {
  it('追加在末尾并跳过已有的题；有新增时递增版本，仍开着的旧页面保存得到 409', async () => {
    t = await makeTestApp();
    const [a, b, c] = [await problem(t), await problem(t), await problem(t)];
    const l = await lesson(t, { items: items([a.id]) });
    const r = await t.json('POST', `/api/lessons/${l.id}/items`, { problemIds: [b.id, a.id, c.id, b.id] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: 2, existing: 1 });
    expect(r.body.lesson.items.map((i: any) => i.problemId)).toEqual([a.id, b.id, c.id]);
    expect(r.body.lesson.version).toBe(2);

    const stale = await t.json('PUT', `/api/lessons/${l.id}`, { expectedVersion: 1, items: items([a.id]) });
    expect(stale.status).toBe(409);

    const none = await t.json('POST', `/api/lessons/${l.id}/items`, { problemIds: [a.id, c.id] });
    expect(none.body).toMatchObject({ added: 0, existing: 2, lesson: { version: 2 } });
  });

  it('回收站中的题不能加入；回收站中的教案不能追加', async () => {
    t = await makeTestApp();
    const a = await problem(t);
    const b = await problem(t);
    const l = await lesson(t, { items: items([a.id]) });
    await t.request('DELETE', `/api/problems/${b.id}`);
    expect((await t.json('POST', `/api/lessons/${l.id}/items`, { problemIds: [b.id] })).status).toBe(400);
    await t.request('DELETE', `/api/lessons/${l.id}`);
    expect((await t.json('POST', `/api/lessons/${l.id}/items`, { problemIds: [a.id] })).status).toBe(409);
    expect((await t.json('POST', `/api/lessons/${newId()}/items`, { problemIds: [a.id] })).status).toBe(404);
  });
});

describe('教案列表与回收站', () => {
  it('列表按修改时间倒序，带题数与预览；可按题目筛选；删除后进回收站、不能编辑，恢复后照常', async () => {
    t = await makeTestApp();
    const a = await problem(t, '甲');
    const b = await problem(t);
    const first = await lesson(t, { title: '第一讲', items: items([a.id, b.id]) });
    const second = await lesson(t, { title: '第二讲', items: items([b.id]) });
    await t.json('PUT', `/api/lessons/${first.id}`, { expectedVersion: 1, title: '第一讲（改）', items: items([a.id, b.id]) });

    const list = (await t.json('GET', '/api/lessons')).body;
    expect(list.map((l: any) => l.title)).toEqual(['第一讲（改）', '第二讲']);
    expect(list[0]).toMatchObject({ problemCount: 2, preview: ['甲', expect.stringContaining('题干')] });
    expect((await t.json('GET', `/api/lessons?problemId=${a.id}`)).body.map((l: any) => l.id)).toEqual([first.id]);
    expect((await t.json('GET', `/api/lessons?problemId=${b.id}`)).body).toHaveLength(2);

    const del = await t.json('DELETE', `/api/lessons/${second.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ version: 2, deletedAt: expect.any(String) });
    expect((await t.json('GET', '/api/lessons')).body.map((l: any) => l.id)).toEqual([first.id]);
    const trash = (await t.json('GET', '/api/trash')).body;
    expect(trash.lessons).toEqual([{ id: second.id, title: '第二讲', problemCount: 1, deletedAt: expect.any(String) }]);
    const blocked = await t.json('PUT', `/api/lessons/${second.id}`, { expectedVersion: 2, items: [] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('回收站');

    const restored = await t.json('POST', `/api/lessons/${second.id}/restore`);
    expect(restored.body).toMatchObject({ version: 3, deletedAt: null });
    expect((await t.json('GET', '/api/lessons')).body).toHaveLength(2);
    expect((await t.json('GET', `/api/lessons/${newId()}`)).status).toBe(404);
  });
});

describe('教案的变更事件', () => {
  it('新建、修改、追加都发出 lessons.changed（带版本与发起页），失败的写入不发', async () => {
    t = await makeTestApp();
    const a = await problem(t);
    const b = await problem(t);
    await new Promise((r) => setImmediate(r));
    const res = await t.request('GET', '/api/events');
    const r = readSse(res);
    readers.push(r);
    await r.next((e) => e.event === 'hello');
    const lessonChange = (e: { event: string; data: string }) => e.event === 'change' && JSON.parse(e.data).type === 'lessons.changed';

    const id = newId();
    expect((await t.request('POST', '/api/lessons', { id, items: items([a.id]) }, { 'x-sworks-client': 'tab-1' })).status).toBe(201);
    const created = JSON.parse((await r.next(lessonChange)).data);
    expect(created).toMatchObject({ lessons: [{ id, version: 1, deleted: false }], created: [id], origin: { kind: 'web', clientId: 'tab-1' } });

    // 失败（重复的题）的写入不发事件；接着的成功写入是下一条
    expect((await t.request('PUT', `/api/lessons/${id}`, { expectedVersion: 1, items: items([a.id, a.id]) })).status).toBe(400);
    expect((await t.request('POST', `/api/lessons/${id}/items`, { problemIds: [b.id] })).status).toBe(200);
    const added = JSON.parse((await r.next(lessonChange)).data);
    expect(added).toMatchObject({ lessons: [{ id, version: 2 }], created: [] });
  });
});
