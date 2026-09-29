import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db/connection.js';
import { sha256File } from '../../src/server/services/assetStore.js';
import { exportRecords } from '../../src/server/services/backupFormat.js';
import { LATEST_SCHEMA_VERSION } from '../../src/server/db/migrations.js';
import { restoreBackup } from '../../src/server/services/restore.js';
import { fakePng, makeTempDir, makeTestApp, newId, uploadImage, type TestApp } from '../helpers/server.js';
import { readZip, rezip, writeRawZip, zipWithTraversalEntry } from '../helpers/zip.js';

let t: TestApp | undefined;
let work: string;
beforeEach(async () => {
  work = await makeTempDir('sworks-backup-test-');
});
afterEach(() => {
  t?.close();
  t = undefined;
});

const NOTE_MD = [
  '> [!tip] 换元提醒',
  '> 先令 $t=x^2$，再检查取值范围。',
  '',
  '> [!answer]- 展开参考答案',
  '> $$\\int_0^1 x\\,dx = \\frac12$$',
  '',
  '> [!note] 解题过程',
  '> 第一种思路。',
  '>',
  '> > [!warning] 易漏条件',
  '> > 注意变量的定义域。',
].join('\n');

/** 综合测试数据：无标题多图题 + 三类笔记 + callout/公式 + 来源资料 + 标签 + 回收站记录 */
async function seed(t: TestApp) {
  const img1 = await uploadImage(t, fakePng(2000), '截图1.png');
  const img2 = await uploadImage(t, fakePng(3000), '截图2.png');
  const shared = await uploadImage(t, fakePng(1000), 'shared.png');
  const mid = newId();
  await t.json('POST', '/api/materials', {
    id: mid,
    title: '数列专题摘录',
    status: 'inbox',
    tags: ['数列'],
    sourceNote: '某教辅 P12',
    blocks: [
      { id: newId(), kind: 'markdown', body: '资料正文 $a_n$' },
      { id: newId(), kind: 'image', assetId: shared.asset.id, caption: '资料图' },
    ],
  });
  const raw = await t.json('POST', '/api/raw-inputs/text', { text: '粘贴的原文 **原样**' });
  // 远程图片：一个失败的
  const failed = await t.json('POST', '/api/remote-images', { url: 'http://127.0.0.1:9/never.png' });
  const pid = newId();
  const deletedNote = newId();
  await t.json('POST', '/api/problems', {
    id: pid,
    tags: ['函数', '换元'],
    subject: '数学',
    stage: '高中',
    blocks: [
      { id: newId(), kind: 'image', assetId: img1.asset.id },
      { id: newId(), kind: 'markdown', body: `如图，求 $f(x)$ 的最小值。\n\n![](assets/${shared.asset.id}.png)` },
      { id: newId(), kind: 'image', assetId: img2.asset.id, caption: '第二张' },
      { id: newId(), kind: 'text', body: '粘贴的原文 **原样**' },
      { id: newId(), kind: 'image', remoteImageId: failed.body.remoteImage.id },
    ],
    notes: [
      { id: newId(), type: 'note', title: '我的思考', bodyMd: NOTE_MD },
      { id: newId(), type: 'answer', bodyMd: '$x=1$' },
      { id: newId(), type: 'solution', title: '参考解析', bodyMd: '由 $$x^2\\ge 0$$ 得' },
      { id: deletedNote, type: 'note', bodyMd: '将被删除的笔记' },
    ],
    sources: [{ materialId: mid, note: '第 2 题' }],
    rawInputIds: [raw.body.rawInputId, img1.rawInputId, img2.rawInputId],
  });
  // 删除一条笔记，删除另一道题 → 回收站记录
  const cur = await t.json('GET', `/api/problems/${pid}`);
  await t.json('PUT', `/api/problems/${pid}`, {
    expectedVersion: cur.body.version,
    title: null,
    subject: '数学',
    stage: '高中',
    tags: ['函数', '换元'],
    blocks: cur.body.blocks.map((b: any) => ({ id: b.id, kind: b.kind, body: b.body, assetId: b.assetId, remoteImageId: b.remoteImageId, caption: b.caption })),
    notes: cur.body.notes.filter((n: any) => n.id !== deletedNote).map((n: any) => ({ id: n.id, type: n.type, title: n.title, bodyMd: n.bodyMd })),
    sources: [{ materialId: mid, note: '第 2 题' }],
  });
  const trashed = newId();
  await t.json('POST', '/api/problems', { id: trashed, title: '回收站里的题', blocks: [{ id: newId(), kind: 'image', assetId: shared.asset.id }] });
  await t.request('DELETE', `/api/problems/${trashed}`);
  // 属性：考点树里子节点比父节点先创建（先建“单调性”，再建“函数”并把前者移到其下）
  const defs = (await t.json('GET', '/api/properties')).body as { id: string; preset: string | null; options: { id: string; label: string }[] }[];
  const kp = defs.find((d) => d.preset === 'knowledge')!;
  const diff = defs.find((d) => d.preset === 'difficulty')!;
  const child = newId();
  const parent = newId();
  await t.json('POST', `/api/properties/${kp.id}/options`, { id: child, label: '单调性' });
  await t.json('POST', `/api/properties/${kp.id}/options`, { id: parent, label: '函数' });
  await t.json('POST', `/api/property-options/${child}/move`, { parentId: parent });
  const year = (await t.json('POST', '/api/properties', { id: newId(), name: '年份', type: 'number' })).body;
  await t.json('POST', '/api/problems/batch', { ids: [pid], action: { op: 'addOptions', propertyId: kp.id, optionIds: [child] } });
  await t.json('POST', '/api/problems/batch', {
    ids: [pid],
    action: { op: 'setProperty', propertyId: diff.id, value: { propertyId: diff.id, optionIds: [diff.options[3]!.id] } },
  });
  await t.json('POST', '/api/problems/batch', { ids: [pid], action: { op: 'setProperty', propertyId: year.id, value: { propertyId: year.id, number: 2023 } } });
  await t.json('POST', '/api/materials/batch', { ids: [mid], action: { op: 'addOptions', propertyId: kp.id, optionIds: [parent] } });
  // 学生与作答记录（含一条已删除的作答、一个已归档的学生）
  const sid = newId();
  await t.json('POST', '/api/students', { id: sid, name: '小明', stage: '高二', note: '周六上课' });
  await t.json('POST', '/api/attempts', { id: newId(), studentId: sid, problemId: pid, result: 'wrong', feltDifficulty: 4, note: '漏了定义域' });
  const removed = newId();
  await t.json('POST', '/api/attempts', { id: removed, studentId: sid, problemId: pid, result: 'correct' });
  await t.json('POST', `/api/attempts/${removed}/delete`);
  const old = newId();
  await t.json('POST', '/api/students', { id: old, name: '已结课的学生' });
  await t.json('POST', `/api/students/${old}/archive`);
  // v4 新增的数据（接口在后续阶段提供，这里直接写库）：笔记序号、原文件摘要、常用检索
  const db = t.lib.db;
  db.prepare("UPDATE notes SET seq = 2 WHERE problem_id = ? AND type = 'answer'").run(pid);
  db.prepare('UPDATE raw_inputs SET original_mime = ?, original_size = ?, original_sha256 = ? WHERE id = ?').run(
    'image/heic',
    123456,
    'f'.repeat(64),
    img1.rawInputId,
  );
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO saved_searches (id, scope, name, query_json, sort, position, show_in_nav, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?)',
  ).run(newId(), 'problem', '函数错题', JSON.stringify({ v: 1, text: 'tag:函数', ast: null }), null, now, now);
  return { pid, mid, trashed, deletedNote };
}

async function makeBackup(t: TestApp): Promise<string> {
  const res = await t.json('POST', '/api/backups');
  expect(res.status).toBe(201);
  return path.join(t.lib.paths.backups, res.body.fileName);
}

function snapshotAll(dbFile: string) {
  const db = openDatabase(dbFile, { mustExist: true, readonly: true });
  try {
    return exportRecords(db).tables;
  } finally {
    db.close();
  }
}

describe('全库备份与恢复往返', () => {
  it('恢复后 ID、源码、类型、顺序、属性、来源、软删除状态一致，原始附件哈希一致', async () => {
    t = await makeTestApp();
    const seeded = await seed(t);
    const zip = await makeBackup(t);
    const listed = await t.json('GET', '/api/backups');
    expect(listed.body.backups[0].fileName).toBe(path.basename(zip));
    expect(listed.body.lastBackupAt).not.toBeNull();

    const entries = await readZip(zip);
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain('manifest.json');
    expect(names).toContain('records.json');
    expect(names).toContain('README.txt');
    const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json')!.data.toString());
    expect(manifest.format).toBe('sworks-backup');
    expect(manifest.integrity.localDataComplete).toBe(true);
    expect(manifest.integrity.allRemoteImagesArchived).toBe(false);
    expect(manifest.remoteImages.unarchived[0].url).toBe('http://127.0.0.1:9/never.png');
    // 备份不递归包含其他备份或临时文件
    expect(names.every((n) => /^(manifest\.json|records\.json|README\.txt|assets\/[0-9a-f]{64})$/.test(n))).toBe(true);

    const before = snapshotAll(t.lib.paths.db);
    const target = path.join(work, 'restored');
    const result = await restoreBackup(zip, target);
    expect(result.counts.problems).toBe(2);

    const after = snapshotAll(path.join(target, 'db.sqlite3'));
    // 逻辑数据一致（不比较 ZIP 字节）
    expect(after).toEqual(before);
    expect(after.property_values.length).toBe(4);
    expect(after.students.length).toBe(2);
    expect(after.student_attempts.filter((a) => a.deleted_at !== null)).toHaveLength(1);
    expect(after.property_options.some((o) => o.label === '单调性' && o.parent_id !== null)).toBe(true);
    const p = after.problems.find((x) => x.id === seeded.pid)!;
    expect(p.title).toBeNull();
    expect(after.problems.find((x) => x.id === seeded.trashed)!.deleted_at).not.toBeNull();
    expect(after.notes.find((n) => n.id === seeded.deletedNote)!.deleted_at).not.toBeNull();
    expect(after.notes.find((n) => n.body_md === NOTE_MD)).toBeTruthy();
    expect(after.materials[0]!.status).toBe('inbox');
    expect(after.notes.find((n) => n.type === 'answer')!.seq).toBe(2);
    expect(after.raw_inputs.filter((r) => r.original_mime === 'image/heic')).toHaveLength(1);
    expect(after.saved_searches.map((x) => x.name)).toEqual(['函数错题']);
    // 附件字节一致
    for (const a of after.assets) {
      const src = path.join(t.lib.paths.assets, a.rel_path);
      const dst = path.join(target, 'assets', a.rel_path);
      expect(await sha256File(dst)).toBe(a.sha256);
      expect(fs.readFileSync(dst).equals(fs.readFileSync(src))).toBe(true);
    }

    // 用恢复出的目录启动：内容可读、图片可显示、搜索可用
    t.close();
    t = await makeTestApp({ dataDir: target });
    const got = await t.json('GET', `/api/problems/${seeded.pid}`);
    expect(got.body.notes.map((n: any) => n.type)).toEqual(['note', 'answer', 'solution']);
    expect(got.body.blocks.map((b: any) => b.kind)).toEqual(['image', 'markdown', 'image', 'text', 'image']);
    const img = await t.request('GET', `/api/assets/${got.body.blocks[0].assetId}`);
    expect(img.status).toBe(200);
    const search = await t.json('GET', `/api/problems?q=${encodeURIComponent('易漏条件')}`);
    expect(search.body.items.map((i: any) => i.id)).toEqual([seeded.pid]);
    const trash = await t.json('GET', '/api/trash');
    expect(trash.body.problems[0].id).toBe(seeded.trashed);
  });

  it('再次备份恢复后的库，逻辑数据仍一致（ZIP 字节可以不同）', async () => {
    t = await makeTestApp();
    await seed(t);
    const zip1 = await makeBackup(t);
    const r1 = path.join(work, 'r1');
    await restoreBackup(zip1, r1);
    t.close();
    t = await makeTestApp({ dataDir: r1 });
    const zip2 = await makeBackup(t);
    const r2 = path.join(work, 'r2');
    await restoreBackup(zip2, r2);
    expect(snapshotAll(path.join(r2, 'db.sqlite3'))).toEqual(snapshotAll(path.join(r1, 'db.sqlite3')));
  });
});

describe('篡改、损坏、未知版本和越界路径均被拒绝，原库不受影响', () => {
  async function prepare() {
    t = await makeTestApp();
    await seed(t);
    const zip = await makeBackup(t);
    const dbBefore = fs.readFileSync(t.lib.paths.db);
    return { zip, dbBefore };
  }

  async function expectRejected(zip: string, code: string, messagePart?: string) {
    const target = path.join(work, `target-${Math.random().toString(36).slice(2)}`);
    const err = await restoreBackup(zip, target).then(
      () => null,
      (e: { code: string; message: string }) => e,
    );
    expect(err, 'restore should fail').not.toBeNull();
    expect(err!.code).toBe(code);
    if (messagePart) expect(err!.message).toContain(messagePart);
    // 目标目录不存在、没有残留临时目录
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(work).filter((n) => n.startsWith('.sworks-restore-'))).toEqual([]);
  }

  it('篡改附件字节', async () => {
    const { zip, dbBefore } = await prepare();
    const bad = path.join(work, 'tampered-asset.zip');
    let done = false;
    await rezip(zip, bad, (e) => {
      if (!done && e.name.startsWith('assets/')) {
        done = true;
        const copy = Buffer.from(e.data);
        copy[copy.length - 1] = copy[copy.length - 1]! ^ 0xff;
        return copy;
      }
      return e.data;
    });
    await expectRejected(bad, 'BACKUP_INVALID', '哈希不符');
    expect(fs.readFileSync(t!.lib.paths.db).equals(dbBefore)).toBe(true);
  });

  it('篡改 records.json', async () => {
    const { zip } = await prepare();
    const bad = path.join(work, 'tampered-records.zip');
    await rezip(zip, bad, (e) => (e.name === 'records.json' ? Buffer.from(e.data.toString().replace('数列专题摘录', '被篡改的标题')) : e.data));
    await expectRejected(bad, 'BACKUP_INVALID', '校验和');
  });

  it('损坏的清单', async () => {
    const { zip } = await prepare();
    const bad = path.join(work, 'bad-manifest.zip');
    await rezip(zip, bad, (e) => (e.name === 'manifest.json' ? Buffer.from('{"format": "sworks-backup", ') : e.data));
    await expectRejected(bad, 'BACKUP_INVALID', 'manifest');
    const missing = path.join(work, 'no-manifest.zip');
    await rezip(zip, missing, (e) => (e.name === 'manifest.json' ? null : e.data));
    await expectRejected(missing, 'BACKUP_INVALID', 'manifest');
    const noAsset = path.join(work, 'missing-asset.zip');
    let dropped = false;
    await rezip(zip, noAsset, (e) => {
      if (!dropped && e.name.startsWith('assets/')) {
        dropped = true;
        return null;
      }
      return e.data;
    });
    await expectRejected(noAsset, 'BACKUP_INVALID', '缺少附件');
  });

  it('未知（更高）版本被拒绝，不猜测字段含义', async () => {
    const { zip } = await prepare();
    const bad = path.join(work, 'future.zip');
    await rezip(zip, bad, (e) => {
      if (e.name !== 'manifest.json') return e.data;
      const m = JSON.parse(e.data.toString());
      m.backupSchemaVersion = 99;
      return Buffer.from(JSON.stringify(m));
    });
    await expectRejected(bad, 'BACKUP_UNSUPPORTED', 'v99');
    const bad2 = path.join(work, 'future-db.zip');
    await rezip(zip, bad2, (e) => {
      if (e.name !== 'manifest.json') return e.data;
      const m = JSON.parse(e.data.toString());
      m.dbSchemaVersion = 42;
      return Buffer.from(JSON.stringify(m));
    });
    await expectRejected(bad2, 'BACKUP_UNSUPPORTED');
  });

  it('越界解压路径、符号链接、未知条目', async () => {
    const { zip } = await prepare();
    const slip = path.join(work, 'zipslip.zip');
    await zipWithTraversalEntry(zip, slip);
    await expectRejected(slip, 'BACKUP_INVALID', '非法路径');
    expect(fs.existsSync(path.join(work, 'evil.txt'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(work), 'evil.txt'))).toBe(false);

    const link = path.join(work, 'symlink.zip');
    await rezip(zip, link, (e) => e.data, [{ name: `assets/${'a'.repeat(64)}`, data: Buffer.from('/etc/passwd'), mode: 0o120777 }]);
    await expectRejected(link, 'BACKUP_INVALID', '符号链接');

    const extra = path.join(work, 'extra.zip');
    await rezip(zip, extra, (e) => e.data, [{ name: 'db.sqlite3', data: Buffer.from('x') }]);
    await expectRejected(extra, 'BACKUP_INVALID', '未知或越界路径');

    const notZip = path.join(work, 'not.zip');
    fs.writeFileSync(notZip, 'hello');
    await expectRejected(notZip, 'BACKUP_INVALID', '不是有效的 ZIP');

    const foreign = path.join(work, 'foreign.zip');
    await writeRawZip(foreign, [{ name: 'manifest.json', data: Buffer.from('{"format":"other","backupSchemaVersion":1,"dbSchemaVersion":1}') }]);
    await expectRejected(foreign, 'BACKUP_INVALID', '不是 SworkS 备份');
  });

  it('只恢复到新的空目录；目标被服务占用或非空时拒绝', async () => {
    const { zip } = await prepare();
    const nonEmpty = path.join(work, 'non-empty');
    fs.mkdirSync(nonEmpty);
    fs.writeFileSync(path.join(nonEmpty, 'keep.txt'), 'user file');
    await expect(restoreBackup(zip, nonEmpty)).rejects.toMatchObject({ code: 'RESTORE_TARGET_INVALID' });
    expect(fs.readFileSync(path.join(nonEmpty, 'keep.txt'), 'utf8')).toBe('user file');
    // 正在运行的库
    await expect(restoreBackup(zip, t!.dataDir)).rejects.toMatchObject({ code: 'RESTORE_TARGET_INVALID' });
    // 空目录可以
    const empty = path.join(work, 'empty');
    fs.mkdirSync(empty);
    await restoreBackup(zip, empty);
    expect(fs.existsSync(path.join(empty, 'db.sqlite3'))).toBe(true);
  });
});

describe('旧版本备份', () => {
  it('v1 备份（初版程序生成）可以恢复到当前版本：先按 v1 写入，再走迁移链补上预置属性', async () => {
    const fixture = path.resolve(import.meta.dirname, '../fixtures/backup-v1.sworks.zip');
    const target = path.join(work, 'restored-v1');
    const result = await restoreBackup(fixture, target);
    expect(result.manifest.backupSchemaVersion).toBe(1);
    expect(result.counts.problems).toBe(2);
    t = await makeTestApp({ dataDir: target });
    const p = (await t.json('GET', '/api/problems/22222222-2222-4222-8222-222222222222')).body;
    expect(p.title).toBe('均值不等式求最值');
    expect(p.tags).toEqual(['函数', '易错']);
    expect(p.properties).toEqual([]);
    expect(p.notes[0].bodyMd).toBe('最小值为 $2$');
    expect((await t.json('GET', '/api/problems/33333333-3333-4333-8333-333333333333')).body.deletedAt).not.toBeNull();
    // 检索投影已重建
    expect((await t.json('GET', `/api/problems?q=${encodeURIComponent('最小值')}`)).body.total).toBe(1);
    // 预置属性由迁移补上
    const defs = (await t.json('GET', '/api/properties')).body as { preset: string }[];
    expect(defs.map((d) => d.preset)).toEqual(['qtype', 'difficulty', 'knowledge']);
    expect(t.lib.db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    // 恢复后的库可以正常备份（当前格式）
    const again = await t.json('POST', '/api/backups');
    expect(again.status).toBe(201);
  });

  it('v3 备份（学生与作答版本生成）可以恢复：笔记序号为空，题型经迁移变为分层，数据完整', async () => {
    const fixture = path.resolve(import.meta.dirname, '../fixtures/backup-v3.sworks.zip');
    const target = path.join(work, 'restored-v3');
    const result = await restoreBackup(fixture, target);
    expect(result.manifest.backupSchemaVersion).toBe(3);
    expect(result.counts.student_attempts).toBe(1);
    t = await makeTestApp({ dataDir: target });
    const p = (await t.json('GET', '/api/problems/44444444-4444-4444-8444-444444444444')).body;
    expect(p.title).toBe('判断函数单调性');
    expect(p.notes.map((n: any) => [n.type, n.seq])).toEqual([
      ['answer', null],
      ['solution', null],
    ]);
    expect(p.rawInputs[0].original).toBeNull();
    expect(p.properties).toHaveLength(3);
    const defs = (await t.json('GET', '/api/properties')).body as { preset: string; nested: boolean }[];
    expect(defs.find((d) => d.preset === 'qtype')!.nested).toBe(true);
    const st = (await t.json('GET', '/api/students/66666666-6666-4666-8666-666666666666')).body;
    expect(st.stats).toMatchObject({ attempts: 1, wrong: 1 });
    expect((await t.json('GET', `/api/problems?q=${encodeURIComponent('单调性')}`)).body.total).toBe(1);
    expect(t.lib.db.pragma('user_version', { simple: true })).toBe(LATEST_SCHEMA_VERSION);
  });

  it('不认识的备份版本组合被拒绝', async () => {
    t = await makeTestApp();
    await seed(t);
    const zip = await makeBackup(t);
    const entries = await readZip(zip);
    const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json')!.data.toString());
    manifest.backupSchemaVersion = 1; // 声称 v1 格式，却带着 v2 数据库版本
    const bad = path.join(work, 'mismatch.zip');
    await rezip(zip, bad, (e) => (e.name === 'manifest.json' ? Buffer.from(JSON.stringify(manifest)) : e.data));
    await expect(restoreBackup(bad, path.join(work, 'x'))).rejects.toMatchObject({ code: 'BACKUP_UNSUPPORTED' });
  });
});
