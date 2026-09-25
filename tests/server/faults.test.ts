import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { fakePng, makeTestApp, newId, type TestApp } from '../helpers/server.js';

let t: TestApp | undefined;
const restorePerms: (() => void)[] = [];
afterEach(() => {
  for (const f of restorePerms.splice(0)) f();
  t?.close();
  t = undefined;
});

const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

describe('异常路径不显示虚假成功', () => {
  it.skipIf(isRoot)('磁盘不可写：上传明确失败（DISK_WRITE_FAILED），不产生记录', async () => {
    t = await makeTestApp();
    for (const dir of [t.lib.paths.assets, t.lib.paths.tmp]) {
      fs.chmodSync(dir, 0o500);
      restorePerms.push(() => fs.chmodSync(dir, 0o755));
    }
    const res = await t.upload('/api/uploads/image', fakePng(), 'a.png');
    expect(res.status).toBe(507);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('DISK_WRITE_FAILED');
    expect(body.error.message).toContain('未保存');
    expect((t.lib.db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n).toBe(0);
    expect((t.lib.db.prepare('SELECT COUNT(*) AS n FROM raw_inputs').get() as { n: number }).n).toBe(0);
    // 恢复权限后重试成功
    for (const f of restorePerms.splice(0)) f();
    expect((await t.upload('/api/uploads/image', fakePng(), 'a.png')).status).toBe(201);
  });

  it('数据库异常：保存失败返回 DB_ERROR，事务整体回滚；修复后用同一 ID 重试成功', async () => {
    t = await makeTestApp();
    t.lib.db.exec("CREATE TRIGGER fail_notes BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'simulated failure'); END");
    const id = newId();
    const body = {
      id,
      blocks: [{ id: newId(), kind: 'markdown', body: '题干' }],
      notes: [{ id: newId(), type: 'note', bodyMd: '笔记' }],
    };
    const res = await t.json('POST', '/api/problems', body);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('DB_ERROR');
    // 题目本身也没有写入（整体回滚）
    expect(t.lib.db.prepare('SELECT 1 FROM problems WHERE id = ?').get(id)).toBeUndefined();
    t.lib.db.exec('DROP TRIGGER fail_notes');
    const retry = await t.json('POST', '/api/problems', body);
    expect(retry.status).toBe(201);
    expect(retry.body.entity.notes).toHaveLength(1);
  });

  it('更新失败时原数据保持不变', async () => {
    t = await makeTestApp();
    const id = newId();
    const block = { id: newId(), kind: 'markdown', body: '原内容' };
    await t.json('POST', '/api/problems', { id, blocks: [block] });
    t.lib.db.exec("CREATE TRIGGER fail_upd BEFORE UPDATE ON content_blocks BEGIN SELECT RAISE(ABORT, 'simulated'); END");
    const res = await t.json('PUT', `/api/problems/${id}`, { expectedVersion: 1, blocks: [{ ...block, body: '新内容' }] });
    expect(res.status).toBe(500);
    t.lib.db.exec('DROP TRIGGER fail_upd');
    const got = await t.json('GET', `/api/problems/${id}`);
    expect(got.body.blocks[0].body).toBe('原内容');
    expect(got.body.version).toBe(1);
  });
});
