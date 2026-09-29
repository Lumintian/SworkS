import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { restoreBackup } from '../../src/server/services/restore.js';
import { makeTempDir, makeTestApp, newId, type TestApp } from '../helpers/server.js';
import { openLibrary } from '../../src/server/library.js';
import { listSavedSearches } from '../../src/server/services/savedSearches.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

async function problem(t: TestApp, extra: Record<string, unknown>) {
  const r = await t.json('POST', '/api/problems', { id: newId(), blocks: [], ...extra });
  expect(r.status).toBe(201);
  return r.body.entity.id as string;
}

async function save(t: TestApp, name: string, text: string, scope = 'problem') {
  const r = await t.json('POST', '/api/saved-searches', { id: newId(), scope, name, text });
  return r;
}

describe('常用检索', () => {
  it('新建、按当前名称显示、改名改条件、排序、计数、软删除', async () => {
    t = await makeTestApp();
    const defs = (await t.json('GET', '/api/properties')).body as { id: string; preset: string; options: { id: string; path: string }[] }[];
    const diff = defs.find((d) => d.preset === 'difficulty')!;
    const hardId = diff.options.find((o) => o.path === '较难')!.id;
    await problem(t, { tags: ['函数'], properties: [{ propertyId: diff.id, optionIds: [hardId] }] });
    await problem(t, { tags: ['函数'] });

    const a = await save(t, '函数难题', '#函数 难度:较难');
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ name: '函数难题', text: '#函数 难度:较难', problems: [] });
    const b = (await save(t, '全部函数', '#函数')).body;
    expect((await save(t, '函数难题', 'x')).status).toBe(409);
    expect((await save(t, '坏的', '题型:不存在的题型')).status).toBe(400);

    // 选项改名：保存的是 ID，显示跟着变
    await t.json('PUT', `/api/property-options/${hardId}`, { label: '偏难' });
    const list = (await t.json('GET', '/api/saved-searches?scope=problem')).body as { id: string; text: string }[];
    expect(list.map((s) => s.text)).toEqual(['#函数 难度:偏难', '#函数']);

    const counts = (await t.json('GET', '/api/saved-searches/counts?scope=problem')).body;
    expect(counts).toEqual({ [a.body.id]: 1, [b.id]: 2 });

    const reordered = (await t.json('POST', '/api/saved-searches/reorder', { scope: 'problem', ids: [b.id, a.body.id] })).body as { id: string }[];
    expect(reordered.map((s) => s.id)).toEqual([b.id, a.body.id]);
    const upd = await t.json('PUT', `/api/saved-searches/${b.id}`, { name: '函数题', text: '#函数 -难度:偏难', sort: 'updated' });
    expect(upd.body).toMatchObject({ name: '函数题', text: '#函数 -难度:偏难', sort: 'updated' });
    expect((await t.json('POST', `/api/saved-searches/${a.body.id}/delete`)).status).toBe(200);
    expect(((await t.json('GET', '/api/saved-searches')).body as unknown[]).length).toBe(1);
    // 软删除后可以重新用这个名字
    expect((await save(t, '函数难题', '#函数')).status).toBe(201);
  });

  it('标签改名/删除与学科改名在同一事务里改写保存的条件；删除的选项给出提示', async () => {
    t = await makeTestApp();
    await problem(t, { tags: ['方法/换元', '方法/配方'], subject: '数学' });
    const s1 = (await save(t, '换元', '#方法/换元 学科:数学')).body;
    const s2 = (await save(t, '配方', '#方法/配方')).body;
    await t.json('POST', '/api/tags/rename', { from: '方法', to: '技巧' });
    await t.json('POST', '/api/dict/subject/rename', { from: '数学', to: '高中数学' });
    let byId = new Map(((await t.json('GET', '/api/saved-searches')).body as { id: string; text: string; problems: string[] }[]).map((s) => [s.id, s]));
    expect(byId.get(s1.id)!.text).toBe('#技巧/换元 学科:高中数学');
    await t.json('POST', '/api/tags/delete-many', { paths: ['技巧/配方'] });
    byId = new Map(((await t.json('GET', '/api/saved-searches')).body as { id: string; text: string; problems: string[] }[]).map((s) => [s.id, s]));
    expect(byId.get(s2.id)!.problems[0]).toContain('已删除');

    const defs = (await t.json('GET', '/api/properties')).body as { id: string; preset: string; options: { id: string; path: string }[] }[];
    const qt = defs.find((d) => d.preset === 'qtype')!;
    const fill = qt.options.find((o) => o.path === '填空')!.id;
    const s3 = (await save(t, '填空题', '题型:填空')).body;
    await t.json('POST', '/api/property-options/delete-many', { ids: [fill] });
    const after = ((await t.json('GET', '/api/saved-searches')).body as { id: string; problems: string[] }[]).find((s) => s.id === s3.id)!;
    expect(after.problems.join()).toContain('选项已删除');
  });

  it('备份往返保留常用检索', async () => {
    t = await makeTestApp();
    await save(t, '最近一周', '创建:7天');
    await save(t, '待整理', '状态:待整理', 'material');
    const backup = (await t.json('POST', '/api/backups')).body as { fileName: string };
    const zip = path.join(t.lib.paths.backups, backup.fileName);
    const target = path.join(await makeTempDir(), 'restored');
    const r = await restoreBackup(zip, target);
    expect(r.counts.saved_searches).toBe(2);
    const lib = await openLibrary(target);
    try {
      expect(listSavedSearches(lib.db).map((s) => [s.scope, s.name, s.text])).toEqual([
        ['material', '待整理', '状态:待整理'],
        ['problem', '最近一周', '创建:7天'],
      ]);
    } finally {
      lib.close();
    }
  });
});
