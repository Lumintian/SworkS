import { afterEach, describe, expect, it } from 'vitest';
import { flushChanges } from '../../src/server/events/changes.js';
import { makeTestApp, newId, type TestApp } from '../helpers/server.js';
import { readSse, type SseReader } from '../helpers/sse.js';

let t: TestApp | undefined;
const readers: SseReader[] = [];
afterEach(async () => {
  for (const r of readers.splice(0)) await r.close();
  t?.close();
  t = undefined;
});

/** 测试里请求都在微任务中完成：先让已提交的变更发出去，再开始订阅 */
const settle = () => new Promise((r) => setImmediate(r));

async function connect(app: TestApp, lastEventId?: string): Promise<SseReader> {
  await settle();
  const res = await app.request('GET', '/api/events', undefined, lastEventId ? { 'last-event-id': lastEventId } : {});
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const r = readSse(res);
  readers.push(r);
  await r.next((e) => e.event === 'hello');
  return r;
}

const change = (type: string) => (e: { event: string; data: string }) => e.event === 'change' && JSON.parse(e.data).type === type;

async function createProblem(app: TestApp, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const id = newId();
  const res = await app.request('POST', '/api/problems', { id, blocks: [{ id: newId(), kind: 'markdown', body: '题干' }], ...extra }, headers);
  expect(res.status).toBe(201);
  return id;
}

describe('变更事件（SSE）', () => {
  it('hello 带 bootId；保存后收到新版本与发起页的 clientId，不含内容', async () => {
    t = await makeTestApp();
    const res = await t.request('GET', '/api/events');
    const r = readSse(res);
    readers.push(r);
    const hello = JSON.parse((await r.next((e) => e.event === 'hello')).data);
    expect(hello.bootId).toBe(t.ctx.sse.bootId);

    const id = await createProblem(t, {}, { 'x-sworks-client': 'tab-1' });
    const created = JSON.parse((await r.next(change('entities.changed'))).data);
    expect(created.created).toEqual([id]);
    expect(created.problems).toEqual([{ id, version: 1, deleted: false }]);
    expect(created.origin).toEqual({ kind: 'web', clientId: 'tab-1' });

    const put = await t.request('PUT', `/api/problems/${id}`, { expectedVersion: 1, title: '新标题' }, { 'x-sworks-client': 'tab-2' });
    expect(put.status).toBe(200);
    const ev = await r.next(change('entities.changed'));
    const body = JSON.parse(ev.data);
    expect(body.problems).toEqual([{ id, version: 2, deleted: false }]);
    expect(body.created).toEqual([]);
    expect(body.origin).toEqual({ kind: 'web', clientId: 'tab-2' });
    expect(ev.data).not.toContain('新标题');
    expect(Number(ev.id)).toBeGreaterThan(0);
  });

  it('写入失败（事务回滚）时不发事件；非法的 clientId 被忽略', async () => {
    t = await makeTestApp();
    const r = await connect(t);
    t.lib.db.exec("CREATE TRIGGER fail_notes BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'simulated'); END");
    const failed = await t.request('POST', '/api/problems', { id: newId(), blocks: [], notes: [{ id: newId(), type: 'note', bodyMd: 'x' }] });
    expect(failed.status).toBe(500);
    t.lib.db.exec('DROP TRIGGER fail_notes');
    const ok = await createProblem(t, {}, { 'x-sworks-client': 'bad id!' });
    const body = JSON.parse((await r.next(change('entities.changed'))).data);
    // 第一条事件就是成功的那次；失败的写入没有留下任何记录
    expect(body.created).toEqual([ok]);
    expect(body.origin).toEqual({ kind: 'web' });
    expect(await r.collect(50)).toEqual([]);
  });

  it('批量操作：一次事件里每个对象只出现一次；新标签同时发 catalog 事件', async () => {
    t = await makeTestApp();
    const a = await createProblem(t);
    const b = await createProblem(t);
    const r = await connect(t);
    const res = await t.request('POST', '/api/problems/batch', { ids: [a, b, a], action: { op: 'addTags', names: ['函数', '函数/单调性'] } });
    expect(res.status).toBe(200);
    const ev = JSON.parse((await r.next(change('entities.changed'))).data);
    expect(ev.problems.map((p: { id: string }) => p.id).sort()).toEqual([a, b].sort());
    expect(ev.problems.every((p: { version: number }) => p.version === 2)).toBe(true);
    expect(JSON.parse((await r.next(change('catalog.changed'))).data).parts).toEqual(['tags']);
  });

  it('选项改名只重建检索投影：reindexOnly，版本不变', async () => {
    t = await makeTestApp();
    const defs = (await t.json('GET', '/api/properties')).body as { id: string; preset: string; options: { id: string; path: string }[] }[];
    const qt = defs.find((d) => d.preset === 'qtype')!;
    const fill = qt.options.find((o) => o.path === '填空')!;
    const id = await createProblem(t, { properties: [{ propertyId: qt.id, optionIds: [fill.id] }] });
    const r = await connect(t);
    expect((await t.request('PUT', `/api/property-options/${fill.id}`, { label: '填空题' })).status).toBe(200);
    const ev = JSON.parse((await r.next(change('entities.changed'))).data);
    expect(ev.problems).toEqual([{ id, version: 1, deleted: false }]);
    expect(ev.reindexOnly).toEqual([id]);
    expect(JSON.parse((await r.next(change('catalog.changed'))).data).parts).toEqual(['properties']);
  });

  it('回收站：移入与恢复都递增版本，事件标明 deleted', async () => {
    t = await makeTestApp();
    const id = await createProblem(t);
    const r = await connect(t);
    expect((await t.request('DELETE', `/api/problems/${id}`)).status).toBe(200);
    expect(JSON.parse((await r.next(change('entities.changed'))).data).problems).toEqual([{ id, version: 2, deleted: true }]);
    const row = t.lib.db.prepare('SELECT updated_at, deleted_at FROM problems WHERE id = ?').get(id) as { updated_at: string; deleted_at: string };
    expect(row.updated_at).toBe(row.deleted_at);
  });

  it('作答与学生：attempts / catalog 事件，题目版本不变', async () => {
    t = await makeTestApp();
    const pid = await createProblem(t);
    const sid = newId();
    const r = await connect(t);
    expect((await t.request('POST', '/api/students', { id: sid, name: '小明' })).status).toBe(201);
    expect(JSON.parse((await r.next(change('catalog.changed'))).data).parts).toEqual(['students']);
    expect((await t.request('POST', '/api/attempts', { id: newId(), studentId: sid, problemId: pid, result: 'wrong' })).status).toBe(201);
    const ev = JSON.parse((await r.next(change('attempts.changed'))).data);
    expect(ev).toMatchObject({ studentIds: [sid], problemIds: [pid] });
    expect((await t.json('GET', `/api/problems/${pid}`)).body.version).toBe(1);
  });

  it('远程图片：收录发 rawInputs 事件（页面来源），归档结束发 remoteImages 事件（归档器来源）', async () => {
    t = await makeTestApp();
    const r = await connect(t);
    // 回环地址默认被拦截：归档以失败结束，但同样发出事件
    const res = await t.request('POST', '/api/remote-images', { url: 'http://127.0.0.1:9/a.png' }, { 'x-sworks-client': 'tab-9' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { remoteImage: { id: string; status: string }; rawInputId: string };
    expect(body.remoteImage.status).toBe('failed');
    const events = [...(await r.collect(100))].filter((e) => e.event === 'change').map((e) => JSON.parse(e.data));
    const raw = events.find((e) => e.type === 'rawInputs.created');
    expect(raw).toMatchObject({ ids: [body.rawInputId], origin: { kind: 'web', clientId: 'tab-9' } });
    const archived = events.filter((e) => e.type === 'remoteImages.changed' && e.origin.kind === 'system');
    expect(archived.at(-1)).toMatchObject({ ids: [body.remoteImage.id], origin: { kind: 'system', source: 'archiver' } });
  });

  it('Last-Event-ID：范围内补发缺失的事件；太旧或来自上次启动时发 reset', async () => {
    t = await makeTestApp();
    const first = await connect(t);
    await createProblem(t);
    const e1 = await first.next(change('entities.changed'));
    const b = await createProblem(t);
    const e2 = await first.next(change('entities.changed'));
    await first.close();

    const again = await connect(t, e1.id);
    const replayed = await again.next((e) => e.event === 'change');
    expect(replayed.id).toBe(e2.id);
    expect(JSON.parse(replayed.data).created).toEqual([b]);
    expect(await again.collect(50)).toEqual([]);

    const up = await connect(t, e2.id);
    expect(await up.collect(50)).toEqual([]);

    const stale = await connect(t, '999999');
    expect((await stale.next()).event).toBe('reset');
  });

  it('变更记录只在提交后取出一次（flush 可重复调用）', async () => {
    t = await makeTestApp();
    const r = await connect(t);
    await createProblem(t);
    flushChanges(t.lib.db);
    flushChanges(t.lib.db);
    await r.next(change('entities.changed'));
    expect((await r.collect(50)).filter((e) => e.event === 'change')).toEqual([]);
    expect((t.lib.db.prepare('SELECT COUNT(*) AS n FROM temp.sworks_changes').get() as { n: number }).n).toBe(0);
  });
});
