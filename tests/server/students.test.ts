import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, newId, type TestApp } from '../helpers/server.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

async function problem(t: TestApp, body: Record<string, unknown> = {}) {
  const id = newId();
  const res = await t.json('POST', '/api/problems', { id, blocks: [{ id: newId(), kind: 'markdown', body: `题干 ${id.slice(0, 4)}` }], ...body });
  if (res.status !== 201) throw new Error(JSON.stringify(res.body));
  return res.body.entity as { id: string; version: number; updatedAt: string };
}

async function student(t: TestApp, name = '小明') {
  const res = await t.json('POST', '/api/students', { id: newId(), name, stage: '高中' });
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string; version: number };
}

async function attempt(t: TestApp, studentId: string, problemId: string, result: string, extra: Record<string, unknown> = {}) {
  const res = await t.json('POST', '/api/attempts', { id: newId(), studentId, problemId, result, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string };
}

const version = (t: TestApp, id: string) =>
  (t.lib.db.prepare('SELECT write_version AS v, updated_at FROM problems WHERE id = ?').get(id) as { v: number; updated_at: string });

describe('学生与作答流水', () => {
  it('记录作答不改变题目的版本与修改时间；按客户端 ID 幂等', async () => {
    t = await makeTestApp();
    const p = await problem(t);
    const s = await student(t);
    const before = version(t, p.id);
    const id = newId();
    const body = { id, studentId: s.id, problemId: p.id, result: 'wrong', feltDifficulty: 4, note: '符号错' };
    expect((await t.json('POST', '/api/attempts', body)).status).toBe(201);
    expect((await t.json('POST', '/api/attempts', body)).status).toBe(200);
    expect(version(t, p.id)).toEqual(before);
    const list = (await t.json('GET', `/api/attempts?problemId=${p.id}`)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ studentName: '小明', result: 'wrong', feltDifficulty: 4, note: '符号错' });
  });

  it('统计：做过的题、作答次数、当前错题；软删除作答后不计入，可恢复', async () => {
    t = await makeTestApp();
    const a = await problem(t);
    const b = await problem(t);
    const s = await student(t);
    await attempt(t, s.id, a.id, 'wrong', { attemptedAt: '2026-09-01T10:00:00Z' });
    const fixed = await attempt(t, s.id, a.id, 'correct', { attemptedAt: '2026-09-02T10:00:00Z' });
    await attempt(t, s.id, b.id, 'partial', { attemptedAt: '2026-09-03T10:00:00Z' });
    let st = (await t.json('GET', `/api/students/${s.id}`)).body;
    expect(st.stats).toMatchObject({ problems: 2, attempts: 3, correct: 1, wrong: 1, partial: 1, openMistakes: 1 });
    await t.json('POST', `/api/attempts/${fixed.id}/delete`);
    st = (await t.json('GET', `/api/students/${s.id}`)).body;
    expect(st.stats).toMatchObject({ attempts: 2, openMistakes: 2 });
    await t.json('POST', `/api/attempts/${fixed.id}/restore`);
    expect((await t.json('GET', `/api/students/${s.id}`)).body.stats.openMistakes).toBe(1);
  });

  it('按学生筛选题目：未做过、做过、做错过、最近一次没做对；列表项带作答摘要', async () => {
    t = await makeTestApp();
    const fixedLater = await problem(t, { title: '后来做对' });
    const stillWrong = await problem(t, { title: '仍然错' });
    const untouched = await problem(t, { title: '没做过' });
    const s = await student(t);
    const other = await student(t, '小红');
    await attempt(t, s.id, fixedLater.id, 'wrong', { attemptedAt: '2026-09-01T10:00:00Z', feltDifficulty: 5 });
    await attempt(t, s.id, fixedLater.id, 'correct', { attemptedAt: '2026-09-05T10:00:00Z' });
    await attempt(t, s.id, stillWrong.id, 'blank', { attemptedAt: '2026-09-02T10:00:00Z' });
    await attempt(t, other.id, untouched.id, 'wrong');
    const q = async (f: string) => ((await t!.json('GET', `/api/problems?student=${s.id}&attempt=${f}`)).body.items as { id: string }[]).map((i) => i.id).sort();
    expect(await q('none')).toEqual([untouched.id]);
    expect(await q('done')).toEqual([fixedLater.id, stillWrong.id].sort());
    expect(await q('wrong-ever')).toEqual([fixedLater.id, stillWrong.id].sort());
    expect(await q('wrong-last')).toEqual([stillWrong.id]);
    const items = (await t.json('GET', `/api/problems?student=${s.id}`)).body.items as { id: string; attempt: unknown }[];
    expect(items.find((i) => i.id === fixedLater.id)!.attempt).toMatchObject({ count: 2, wrong: 1, lastResult: 'correct', lastFelt: 5 });
    expect(items.find((i) => i.id === untouched.id)!.attempt).toBeNull();
    // 不带学生时没有作答摘要，attempt 参数被忽略
    const plain = (await t.json('GET', '/api/problems?attempt=none')).body;
    expect(plain.total).toBe(3);
    expect(plain.items[0].attempt).toBeUndefined();
  });

  it('批量记录作答；回收站中的题与已归档的学生不能记录', async () => {
    t = await makeTestApp();
    const a = await problem(t);
    const b = await problem(t);
    const s = await student(t);
    const items = [a, b].map((p) => ({ id: newId(), problemId: p.id }));
    const r = await t.json('POST', '/api/attempts/batch', { studentId: s.id, items, result: 'correct', feltDifficulty: 2 });
    expect(r.body).toEqual({ created: 2 });
    // 重试不重复
    expect((await t.json('POST', '/api/attempts/batch', { studentId: s.id, items, result: 'correct' })).body).toEqual({ created: 0 });
    await t.json('DELETE', `/api/problems/${a.id}`);
    expect((await t.json('POST', '/api/attempts', { id: newId(), studentId: s.id, problemId: a.id, result: 'wrong' })).status).toBe(400);
    await t.json('POST', `/api/students/${s.id}/archive`);
    expect((await t.json('POST', '/api/attempts', { id: newId(), studentId: s.id, problemId: b.id, result: 'wrong' })).status).toBe(400);
    expect((await t.json('GET', '/api/students')).body).toEqual([]);
    expect((await t.json('GET', '/api/students?all=1')).body[0].archived).toBe(true);
  });

  it('薄弱考点：作答计入所属考点及全部上级；少于 3 次不列出；半对按 0.5', async () => {
    t = await makeTestApp();
    const kp = ((await t.json('GET', '/api/properties')).body as { id: string; preset: string }[]).find((d) => d.preset === 'knowledge')!;
    const path = async (p: string) => (await t!.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: p })).body.optionId as string;
    const mono = await path('函数/单调性');
    const parity = await path('函数/奇偶性');
    const seq = await path('数列');
    const p1 = await problem(t, { properties: [{ propertyId: kp.id, optionIds: [mono] }] });
    const p2 = await problem(t, { properties: [{ propertyId: kp.id, optionIds: [parity] }] });
    const p3 = await problem(t, { properties: [{ propertyId: kp.id, optionIds: [seq] }] });
    const s = await student(t);
    await attempt(t, s.id, p1.id, 'wrong');
    await attempt(t, s.id, p1.id, 'wrong');
    await attempt(t, s.id, p1.id, 'partial');
    await attempt(t, s.id, p2.id, 'correct');
    await attempt(t, s.id, p3.id, 'wrong');
    const weak = (await t.json('GET', `/api/students/${s.id}`)).body.weakPoints as { path: string; attempts: number; misses: number; missRate: number; problems: number }[];
    expect(weak.map((w) => w.path)).toEqual(['函数/单调性', '函数']);
    expect(weak[0]).toMatchObject({ attempts: 3, misses: 2.5, problems: 1 });
    expect(weak[1]).toMatchObject({ attempts: 4, misses: 2.5, problems: 2 });
  });

  it('学生信息修改带版本检查；姓名校验', async () => {
    t = await makeTestApp();
    const s = await student(t);
    const r = await t.json('PUT', `/api/students/${s.id}`, { name: '小明（高二）', expectedVersion: 1 });
    expect(r.body).toMatchObject({ name: '小明（高二）', version: 2 });
    expect((await t.json('PUT', `/api/students/${s.id}`, { note: 'x', expectedVersion: 1 })).status).toBe(409);
    expect((await t.json('POST', '/api/students', { id: newId(), name: '   ' })).status).toBe(400);
  });
});
