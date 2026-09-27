import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../src/server/db/migrations.js';
import { openLibrary, type OpenedLibrary } from '../../src/server/library.js';
import { makeTempDir, makeTestApp, type TestApp } from '../helpers/server.js';

const opened: OpenedLibrary[] = [];
let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
  for (const l of opened.splice(0)) l.close();
});

describe('从 v1 升级到最新版本', () => {
  it('有数据的 v1 库升级前写安全备份，写入预置属性，保留检索投影与原有数据', async () => {
    const dir = path.join(await makeTempDir(), 'data');
    const v1 = await openLibrary(dir, { migrations: MIGRATIONS.slice(0, 1) });
    const now = new Date().toISOString();
    const pid = '44444444-4444-4444-8444-444444444444';
    const tid = '55555555-5555-4555-8555-555555555555';
    v1.db.prepare('INSERT INTO problems (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(pid, '升级前的题', now, now);
    v1.db.prepare('INSERT INTO tags (id, name, created_at) VALUES (?, ?, ?)').run(tid, '旧标签', now);
    v1.db.prepare('INSERT INTO problem_tags (problem_id, tag_id) VALUES (?, ?)').run(pid, tid);
    v1.db.prepare("INSERT INTO search_index (owner_kind, owner_id, field, text) VALUES ('problem', ?, 'title', '升级前的题')").run(pid);
    expect(v1.db.pragma('user_version', { simple: true })).toBe(1);
    v1.close();

    const v2 = await openLibrary(dir);
    opened.push(v2);
    expect(v2.migration).toMatchObject({ from: 1, to: LATEST_SCHEMA_VERSION });
    expect(v2.migration.safetyBackup).toMatch(new RegExp(`pre-migration-v1-to-v${LATEST_SCHEMA_VERSION}-.*\\.sqlite3$`));
    expect(fs.existsSync(v2.migration.safetyBackup!)).toBe(true);
    const snap = new Database(v2.migration.safetyBackup!, { readonly: true });
    expect(snap.pragma('user_version', { simple: true })).toBe(1);
    snap.close();
    expect((v2.db.prepare('SELECT preset FROM property_defs ORDER BY position').all() as { preset: string }[]).map((r) => r.preset)).toEqual([
      'qtype',
      'difficulty',
      'knowledge',
    ]);
    expect(v2.db.pragma('foreign_key_check')).toEqual([]);
    // 检索投影随换表保留
    expect(v2.db.prepare('SELECT text FROM search_index WHERE owner_id = ?').get(pid)).toEqual({ text: '升级前的题' });
    v2.close();
    opened.pop();

    // 升级后的库可以照常读写与检索，新的检索字段可用
    t = await makeTestApp({ dataDir: dir });
    const found = await t.json('GET', `/api/problems?q=${encodeURIComponent('升级前')}`);
    expect(found.body.items.map((i: { id: string }) => i.id)).toEqual([pid]);
    const p = (await t.json('GET', `/api/problems/${pid}`)).body;
    expect(p.tags).toEqual(['旧标签']);
    expect(p.properties).toEqual([]);
  });
});
