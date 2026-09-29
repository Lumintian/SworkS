import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../../src/server/context.js';
import { AppError } from '../../src/server/errors.js';
import { ensureOpsRegistered, invokeOp, listOps, type Caller } from '../../src/server/ops/index.js';
import { makeTestApp, newId, type TestApp } from '../helpers/server.js';
import { readSse } from '../helpers/sse.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});
beforeAll(() => ensureOpsRegistered());

const mcp: Caller = { origin: { kind: 'mcp', client: 'test' } };
const call = <T = any>(ctx: AppContext, name: string, input: unknown, caller: Caller = mcp) => invokeOp(ctx, name, input, caller) as Promise<T>;

async function rejects(p: Promise<unknown>, code: string): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
  throw new Error(`应当失败：${code}`);
}

describe('操作注册表', () => {
  it('名称唯一；只读列表只含读操作', () => {
    const all = listOps().map((o) => o.name);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(expect.arrayContaining(['search', 'get_problem', 'create_problem', 'add_note', 'set_properties', 'trash_problem']));
    expect(listOps({ readOnly: true }).every((o) => o.access === 'read')).toBe(true);
    // 插件工具的全名是 <id>__<name>；内置操作名不能含 __（插件接口的类型重载依赖这一点）
    expect(all.every((n) => !n.includes('__'))).toBe(true);
  });

  it('参数校验、未知操作、只读调用方写入', async () => {
    t = await makeTestApp();
    await rejects(call(t.ctx, 'get_problem', { id: 'nope' }), 'VALIDATION');
    await rejects(call(t.ctx, 'no_such_op', {}), 'NOT_FOUND');
    await rejects(call(t.ctx, 'create_problem', { markdown: 'x' }, { ...mcp, readOnly: true }), 'FORBIDDEN');
    const ac = new AbortController();
    ac.abort();
    await rejects(call(t.ctx, 'list_tags', {}, { ...mcp, signal: ac.signal }), 'VALIDATION');
  });

  it('create_problem：带 id 可重试；属性按名称与路径（可自动新建选项）', async () => {
    t = await makeTestApp();
    const id = newId();
    const input = {
      id,
      markdown: 'Choose the best answer.',
      tags: ['英语/完形'],
      properties: [
        { property: '题型', value: '英语/阅读理解' },
        { property: '难度', value: '较难' },
      ],
      createMissingOptions: true,
    };
    const r1 = await call(t.ctx, 'create_problem', input);
    expect(r1).toEqual({ id, version: 1, changed: true, created: true });
    const r2 = await call(t.ctx, 'create_problem', input);
    expect(r2).toEqual({ id, version: 1, changed: false, created: false });
    const p = await call(t.ctx, 'get_problem', { id });
    const props = await call<{ name: string; options: { id: string; path: string }[] }[]>(t.ctx, 'list_properties', {});
    const qt = props.find((d) => d.name === '题型')!;
    expect(qt.options.some((o) => o.path === '英语/阅读理解')).toBe(true);
    expect(p.properties).toHaveLength(2);
    expect(p.tags).toEqual(['英语/完形']);
    // 不自动新建时报错并说明
    await rejects(call(t.ctx, 'create_problem', { markdown: 'x', properties: [{ property: '题型', value: '不存在的题型' }] }), 'VALIDATION');
    await rejects(call(t.ctx, 'create_problem', { markdown: 'x', properties: [{ property: '没有这个属性', value: 'a' }] }), 'VALIDATION');
  });

  it('add_note：递增一次版本、重建检索投影，并发出 mcp 来源的事件', async () => {
    t = await makeTestApp();
    const { id } = await call(t.ctx, 'create_problem', { markdown: '求函数的最小值' });
    await new Promise((r) => setImmediate(r));
    const sse = readSse(await t.request('GET', '/api/events'));
    await sse.next((e) => e.event === 'hello');
    const r = await call(t.ctx, 'add_note', { problemId: id, type: 'solution', bodyMd: '用对勾函数的性质', seq: 1 });
    expect(r).toMatchObject({ id, version: 2, changed: true });
    const ev = JSON.parse((await sse.next((e) => e.event === 'change')).data);
    expect(ev).toMatchObject({ type: 'entities.changed', problems: [{ id, version: 2 }], origin: { kind: 'mcp', client: 'test' } });
    await sse.close();
    const found = await call(t.ctx, 'search', { query: '对勾' });
    expect(found.items.map((i: { id: string }) => i.id)).toEqual([id]);
    const p = await call(t.ctx, 'get_problem', { id });
    expect(p.notes).toMatchObject([{ id: r.noteId, type: 'solution', seq: 1 }]);
    // 同一个 noteId 重试：不重复、不递增
    expect(await call(t.ctx, 'add_note', { problemId: id, id: r.noteId, type: 'solution', bodyMd: '用对勾函数的性质' })).toMatchObject({ version: 2, changed: false });
  });

  it('无变化不递增；版本不符返回冲突且不写入', async () => {
    t = await makeTestApp();
    const { id } = await call(t.ctx, 'create_problem', { markdown: '题干', tags: ['函数'] });
    expect(await call(t.ctx, 'add_tags', { problemId: id, tags: ['函数'] })).toMatchObject({ version: 1, changed: false });
    expect(await call(t.ctx, 'add_tags', { problemId: id, tags: ['函数/单调性'] })).toMatchObject({ version: 2, changed: true });
    const e = await rejects(call(t.ctx, 'remove_tags', { problemId: id, expectedVersion: 1, tags: ['函数'] }), 'CONFLICT');
    expect(e.details).toMatchObject({ currentVersion: 2 });
    expect((await call(t.ctx, 'get_problem', { id })).tags).toEqual(['函数', '函数/单调性']);
    expect(await call(t.ctx, 'remove_tags', { problemId: id, expectedVersion: 2, tags: ['函数'] })).toMatchObject({ version: 3 });
  });

  it('set_properties：末级名唯一时可简写，多个匹配时报错；null 清空；update_note 改序号', async () => {
    t = await makeTestApp();
    await call(t.ctx, 'ensure_option_path', { property: '题型', path: '英语/选择' });
    await call(t.ctx, 'ensure_option_path', { property: '题型', path: '通用/选择' });
    await call(t.ctx, 'ensure_option_path', { property: '题型', path: '英语/完型填空' });
    const { id } = await call(t.ctx, 'create_problem', { markdown: 'x' });
    await rejects(call(t.ctx, 'set_properties', { problemId: id, values: [{ property: '题型', value: '选择' }] }), 'VALIDATION');
    await call(t.ctx, 'set_properties', { problemId: id, values: [{ property: '题型', value: '完型填空' }, { property: '难度', value: '中档' }] });
    let p = await call(t.ctx, 'get_problem', { id });
    expect(p.properties).toHaveLength(2);
    await call(t.ctx, 'set_properties', { problemId: id, values: [{ property: '难度', value: null }] });
    p = await call(t.ctx, 'get_problem', { id });
    expect(p.properties).toHaveLength(1);
    const { noteId } = await call(t.ctx, 'add_note', { problemId: id, type: 'answer', bodyMd: 'C' });
    await call(t.ctx, 'update_note', { noteId, seq: 3 });
    expect((await call(t.ctx, 'get_problem', { id })).notes[0].seq).toBe(3);
  });

  it('record_attempt 不改变题目版本；trash_problem 进回收站', async () => {
    t = await makeTestApp();
    const { id } = await call(t.ctx, 'create_problem', { markdown: 'x' });
    const sid = newId();
    await t.request('POST', '/api/students', { id: sid, name: '小红' });
    const r = await call(t.ctx, 'record_attempt', { studentId: sid, problemId: id, result: 'wrong' });
    expect(r.created).toBe(true);
    expect((await call(t.ctx, 'get_problem', { id })).version).toBe(1);
    expect((await call(t.ctx, 'list_students', {}))[0]).toMatchObject({ id: sid, name: '小红' });
    expect(await call(t.ctx, 'trash_problem', { problemId: id })).toEqual({ id, version: 2 });
    expect((await call(t.ctx, 'get_problem', { id })).deletedAt).not.toBeNull();
  });
});
