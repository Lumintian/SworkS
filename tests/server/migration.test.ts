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

describe('从 v3 升级到 v4', () => {
  it('有数据的 v3 库：写安全备份；笔记序号、原文件摘要为空；题型改为分层；新增常用检索表', async () => {
    const dir = path.join(await makeTempDir(), 'data');
    const v3 = await openLibrary(dir, { migrations: MIGRATIONS.slice(0, 3) });
    const now = new Date().toISOString();
    const pid = '44444444-4444-4444-8444-444444444444';
    const nid = '66666666-6666-4666-8666-666666666666';
    const rid = '77777777-7777-4777-8777-777777777777';
    v3.db.prepare('INSERT INTO problems (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(pid, 'v3 的题', now, now);
    v3.db
      .prepare("INSERT INTO notes (id, problem_id, type, body_md, position, created_at, updated_at) VALUES (?, ?, 'answer', '答案', 0, ?, ?)")
      .run(nid, pid, now, now);
    v3.db.prepare("INSERT INTO raw_inputs (id, kind, text, problem_id, captured_at) VALUES (?, 'text', '原文', ?, ?)").run(rid, pid, now);
    expect(v3.db.pragma('user_version', { simple: true })).toBe(3);
    v3.close();

    const v4 = await openLibrary(dir);
    opened.push(v4);
    expect(v4.migration).toMatchObject({ from: 3, to: LATEST_SCHEMA_VERSION });
    expect(v4.migration.safetyBackup).toMatch(new RegExp(`pre-migration-v3-to-v${LATEST_SCHEMA_VERSION}-.*\\.sqlite3$`));
    expect(v4.db.prepare('SELECT seq FROM notes WHERE id = ?').get(nid)).toEqual({ seq: null });
    expect(v4.db.prepare('SELECT original_mime, original_size, original_sha256 FROM raw_inputs WHERE id = ?').get(rid)).toEqual({
      original_mime: null,
      original_size: null,
      original_sha256: null,
    });
    expect(v4.db.prepare("SELECT nested FROM property_defs WHERE preset = 'qtype'").get()).toEqual({ nested: 1 });
    expect(v4.db.prepare('SELECT COUNT(*) AS n FROM saved_searches').get()).toEqual({ n: 0 });
    expect(v4.db.pragma('foreign_key_check')).toEqual([]);
    // 原文件摘要三列必须同空同非空
    expect(() => v4.db.prepare("UPDATE raw_inputs SET original_mime = 'image/heic' WHERE id = ?").run(rid)).toThrow(/CHECK/);
    expect(() => v4.db.prepare('UPDATE notes SET seq = 1000 WHERE id = ?').run(nid)).toThrow(/CHECK/);
    v4.close();
    opened.pop();

    t = await makeTestApp({ dataDir: dir });
    const p = (await t.json('GET', `/api/problems/${pid}`)).body;
    expect(p.notes[0]).toMatchObject({ id: nid, seq: null });
    expect(p.rawInputs[0]).toMatchObject({ id: rid, original: null });
  });
});
