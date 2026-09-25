import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, fakePng, newId, uploadImage, type TestApp } from '../helpers/server.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

describe('收集与编辑', () => {
  it('粘贴单张截图，不填标题/属性即可保存；重启后原图和内容仍在', async () => {
    t = await makeTestApp();
    const bytes = fakePng(4096);
    const up = await uploadImage(t, bytes, 'clipboard.png');
    const id = newId();
    const blockId = newId();
    const res = await t.json('POST', '/api/problems', {
      id,
      blocks: [{ id: blockId, kind: 'image', assetId: up.asset.id }],
      rawInputIds: [up.rawInputId],
    });
    expect(res.status).toBe(201);
    expect(res.body.entity.title).toBeNull();
    expect(res.body.entity.subject).toBeNull();

    // “重启”：关闭并重新打开同一数据目录
    const dataDir = t.dataDir;
    t.close();
    t = await makeTestApp({ dataDir });
    const got = await t.json('GET', `/api/problems/${id}`);
    expect(got.status).toBe(200);
    expect(got.body.blocks).toHaveLength(1);
    expect(got.body.blocks[0].assetId).toBe(up.asset.id);
    expect(got.body.rawInputs).toHaveLength(1);
    expect(got.body.rawInputs[0].kind).toBe('file');
    const img = await t.request('GET', `/api/assets/${up.asset.id}`);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');
    const served = Buffer.from(await img.arrayBuffer());
    expect(served.equals(bytes)).toBe(true);
  });

  it('多图与穿插文字；调整顺序后重开一致', async () => {
    t = await makeTestApp();
    const a = await uploadImage(t);
    const b = await uploadImage(t);
    const id = newId();
    const blocks = [
      { id: newId(), kind: 'markdown', body: '已知 $f(x)=x^2$，' },
      { id: newId(), kind: 'image', assetId: a.asset.id, caption: '图1' },
      { id: newId(), kind: 'text', body: '（原文照录）' },
      { id: newId(), kind: 'image', assetId: b.asset.id },
    ];
    await t.json('POST', '/api/problems', { id, blocks });
    const reordered = [blocks[3], blocks[0], blocks[2], blocks[1]];
    const put = await t.json('PUT', `/api/problems/${id}`, { expectedVersion: 1, blocks: reordered });
    expect(put.status).toBe(200);
    expect(put.body.changed).toBe(true);
    expect(put.body.entity.version).toBe(2);
    const got = await t.json('GET', `/api/problems/${id}`);
    expect(got.body.blocks.map((x: { id: string }) => x.id)).toEqual(reordered.map((x) => x!.id));
    expect(got.body.blocks[3].caption).toBe('图1');
  });

  it('普通文字中的 Markdown 标记按字面保留', async () => {
    t = await makeTestApp();
    const id = newId();
    const literal = '# 不是标题\n**不是粗体** $x$ > [!tip] 不是 callout';
    await t.json('POST', '/api/problems', { id, blocks: [{ id: newId(), kind: 'text', body: literal }] });
    const got = await t.json('GET', `/api/problems/${id}`);
    expect(got.body.blocks[0].kind).toBe('text');
    expect(got.body.blocks[0].body).toBe(literal);
  });

  it('title 未填写或清空时数据库保持 NULL', async () => {
    t = await makeTestApp();
    const id = newId();
    await t.json('POST', '/api/problems', { id, title: '   ', blocks: [{ id: newId(), kind: 'markdown', body: '一道题' }] });
    const row = () => t!.lib.db.prepare('SELECT title FROM problems WHERE id = ?').get(id) as { title: string | null };
    expect(row().title).toBeNull();
    const p1 = await t.json('PUT', `/api/problems/${id}`, { expectedVersion: 1, title: '有标题', blocks: [] });
    expect(row().title).toBe('有标题');
    await t.json('PUT', `/api/problems/${id}`, { expectedVersion: p1.body.entity.version, title: '', blocks: [] });
    expect(row().title).toBeNull();
  });

  it('同题多条普通笔记、答案、解析，类型与顺序不丢', async () => {
    t = await makeTestApp();
    const id = newId();
    const notes = [
      { id: newId(), type: 'solution', title: '我的解法', bodyMd: '思路一' },
      { id: newId(), type: 'answer', title: null, bodyMd: '$x=1$' },
      { id: newId(), type: 'note', title: '易错', bodyMd: '注意定义域' },
      { id: newId(), type: 'solution', title: '参考解析', bodyMd: '思路二' },
    ];
    await t.json('POST', '/api/problems', { id, notes });
    const got = await t.json('GET', `/api/problems/${id}`);
    expect(got.body.notes.map((n: { id: string; type: string }) => [n.id, n.type])).toEqual(notes.map((n) => [n.id, n.type]));
    expect(got.body.notes[0].title).toBe('我的解法');
  });

  it('资料可以独立保存；从资料建题后资料仍存在，双方编辑不互相覆盖', async () => {
    t = await makeTestApp();
    const img = await uploadImage(t);
    const mid = newId();
    const mb1 = newId();
    const mb2 = newId();
    const created = await t.json('POST', '/api/materials', {
      id: mid,
      status: 'inbox',
      blocks: [
        { id: mb1, kind: 'markdown', body: '专题摘录：数列求和' },
        { id: mb2, kind: 'image', assetId: img.asset.id },
      ],
    });
    expect(created.status).toBe(201);
    const pid = newId();
    const derived = await t.json('POST', `/api/materials/${mid}/derive`, {
      problemId: pid,
      blockIds: [mb1, mb2],
      note: '第 3 页',
      markMaterialActive: true,
    });
    expect(derived.status).toBe(201);
    expect(derived.body.entity.blocks).toHaveLength(2);
    expect(derived.body.entity.blocks[0].id).not.toBe(mb1);
    expect(derived.body.entity.sources[0].materialId).toBe(mid);
    // 重复提交不会产生第二道题
    const again = await t.json('POST', `/api/materials/${mid}/derive`, { problemId: pid, blockIds: [mb1] });
    expect(again.status).toBe(200);
    expect((t.lib.db.prepare('SELECT COUNT(*) AS n FROM problems').get() as { n: number }).n).toBe(1);

    const m = await t.json('GET', `/api/materials/${mid}`);
    expect(m.body.status).toBe('active');
    expect(m.body.derivedProblems[0].problemId).toBe(pid);

    // 编辑题目不影响资料
    const p = derived.body.entity;
    await t.json('PUT', `/api/problems/${pid}`, {
      expectedVersion: p.version,
      blocks: [{ ...p.blocks[0], body: '改写后的题干' }, p.blocks[1]].map((b: any) => ({
        id: b.id,
        kind: b.kind,
        body: b.body,
        assetId: b.assetId,
        remoteImageId: b.remoteImageId,
        caption: b.caption,
      })),
      sources: [{ materialId: mid, note: '第 3 页' }],
    });
    const m2 = await t.json('GET', `/api/materials/${mid}`);
    expect(m2.body.blocks[0].body).toBe('专题摘录：数列求和');
    // 编辑资料不影响题目
    await t.json('PUT', `/api/materials/${mid}`, {
      expectedVersion: m2.body.version,
      status: 'active',
      blocks: [{ id: mb1, kind: 'markdown', body: '资料改了' }],
    });
    const p2 = await t.json('GET', `/api/problems/${pid}`);
    expect(p2.body.blocks[0].body).toBe('改写后的题干');
    expect(p2.body.blocks[1].assetId).toBe(img.asset.id);
    // 资料可搜索
    const s = await t.json('GET', `/api/materials?q=${encodeURIComponent('资料改')}`);
    expect(s.body.items.map((i: { id: string }) => i.id)).toEqual([mid]);
  });

  it('删除题目/笔记可恢复，且不破坏共用原图或来源资料', async () => {
    t = await makeTestApp();
    const img = await uploadImage(t);
    const mid = newId();
    await t.json('POST', '/api/materials', { id: mid, blocks: [{ id: newId(), kind: 'image', assetId: img.asset.id }] });
    const p1 = newId();
    const p2 = newId();
    const noteId = newId();
    await t.json('POST', '/api/problems', {
      id: p1,
      blocks: [{ id: newId(), kind: 'image', assetId: img.asset.id }],
      notes: [{ id: noteId, type: 'answer', bodyMd: '答案是 42' }],
      sources: [{ materialId: mid }],
    });
    await t.json('POST', '/api/problems', { id: p2, blocks: [{ id: newId(), kind: 'image', assetId: img.asset.id }] });

    // 删除笔记（保存时不再包含它）→ 回收站可见 → 恢复
    const cur = await t.json('GET', `/api/problems/${p1}`);
    const del = await t.json('PUT', `/api/problems/${p1}`, {
      expectedVersion: cur.body.version,
      blocks: cur.body.blocks.map((b: any) => ({ id: b.id, kind: b.kind, assetId: b.assetId })),
      notes: [],
      sources: [{ materialId: mid }],
    });
    expect(del.body.entity.notes).toHaveLength(0);
    let trash = await t.json('GET', '/api/trash');
    expect(trash.body.notes.map((n: { id: string }) => n.id)).toEqual([noteId]);
    const restored = await t.json('POST', `/api/notes/${noteId}/restore`);
    expect(restored.body.notes[0].bodyMd).toBe('答案是 42');

    // 删除题目 → 列表排除 → 回收站 → 恢复
    expect((await t.request('DELETE', `/api/problems/${p1}`)).status).toBe(200);
    const list = await t.json('GET', '/api/problems');
    expect(list.body.items.map((i: { id: string }) => i.id)).toEqual([p2]);
    trash = await t.json('GET', '/api/trash');
    expect(trash.body.problems.map((p: { id: string }) => p.id)).toEqual([p1]);
    // 共用图片与来源资料不受影响
    expect((await t.request('GET', `/api/assets/${img.asset.id}`)).status).toBe(200);
    const m = await t.json('GET', `/api/materials/${mid}`);
    expect(m.body.deletedAt).toBeNull();
    expect(m.body.blocks[0].assetId).toBe(img.asset.id);
    const other = await t.json('GET', `/api/problems/${p2}`);
    expect(other.body.blocks[0].assetId).toBe(img.asset.id);
    // 编辑已删除的题目被拒绝
    const stale = await t.json('PUT', `/api/problems/${p1}`, { expectedVersion: 99, blocks: [] });
    expect(stale.status).toBe(409);
    await t.json('POST', `/api/problems/${p1}/restore`);
    const back = await t.json('GET', `/api/problems/${p1}`);
    expect(back.body.deletedAt).toBeNull();
    expect(back.body.notes).toHaveLength(1);
    expect(back.body.sources[0].materialId).toBe(mid);
  });

  it('两个页面修改同一对象不会静默覆盖；重复提交不会新增两份', async () => {
    t = await makeTestApp();
    const id = newId();
    const body = { id, blocks: [{ id: newId(), kind: 'markdown', body: 'v1' }] };
    const r1 = await t.json('POST', '/api/problems', body);
    const r2 = await t.json('POST', '/api/problems', body);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(r2.body.created).toBe(false);
    expect((t.lib.db.prepare('SELECT COUNT(*) AS n FROM problems').get() as { n: number }).n).toBe(1);

    const block = body.blocks[0]!;
    const pageA = await t.json('PUT', `/api/problems/${id}`, { expectedVersion: 1, blocks: [{ ...block, body: 'A 的修改' }] });
    expect(pageA.status).toBe(200);
    const pageB = await t.json('PUT', `/api/problems/${id}`, { expectedVersion: 1, blocks: [{ ...block, body: 'B 的修改' }] });
    expect(pageB.status).toBe(409);
    expect(pageB.body.error.code).toBe('CONFLICT');
    expect(pageB.body.error.details.currentVersion).toBe(2);
    const got = await t.json('GET', `/api/problems/${id}`);
    expect(got.body.blocks[0].body).toBe('A 的修改');
  });

  it('无实际修改的保存不递增版本、不刷新修改时间；笔记修改会刷新', async () => {
    t = await makeTestApp();
    const id = newId();
    const block = { id: newId(), kind: 'markdown', body: 'x' };
    const note = { id: newId(), type: 'note', bodyMd: '想法' };
    const c = await t.json('POST', '/api/problems', { id, blocks: [block], notes: [note], tags: ['函数'] });
    const same = await t.json('PUT', `/api/problems/${id}`, { expectedVersion: 1, blocks: [block], notes: [note], tags: ['函数'] });
    expect(same.body.changed).toBe(false);
    expect(same.body.entity.version).toBe(1);
    expect(same.body.entity.updatedAt).toBe(c.body.entity.updatedAt);
    await new Promise((r) => setTimeout(r, 5));
    const edited = await t.json('PUT', `/api/problems/${id}`, {
      expectedVersion: 1,
      blocks: [block],
      notes: [{ ...note, bodyMd: '新想法' }],
      tags: ['函数'],
    });
    expect(edited.body.changed).toBe(true);
    expect(edited.body.entity.updatedAt > c.body.entity.updatedAt).toBe(true);
  });

  it('Markdown 源码逐字保存，不重排、不删除未知语法', async () => {
    t = await makeTestApp();
    const id = newId();
    const weird = '  缩进保留\n\n[[双链]] ![[附件嵌入]] %%注释%%\n\n> [!Unknown-Type]+ 自定义\n> 内容\t制表符\r\n行尾\n\n\n';
    await t.json('POST', '/api/problems', { id, blocks: [{ id: newId(), kind: 'markdown', body: weird }], notes: [{ id: newId(), type: 'note', bodyMd: weird }] });
    const got = await t.json('GET', `/api/problems/${id}`);
    expect(got.body.blocks[0].body).toBe(weird);
    expect(got.body.notes[0].bodyMd).toBe(weird);
  });

  it('原始输入保留：粘贴文字的原文不被后续编辑覆盖；同一图片字节复用文件但记录独立', async () => {
    t = await makeTestApp();
    const raw = await t.json('POST', '/api/raw-inputs/text', { text: '原始粘贴  文本' });
    const id = newId();
    const blockId = newId();
    await t.json('POST', '/api/problems', {
      id,
      blocks: [{ id: blockId, kind: 'text', body: '原始粘贴  文本' }],
      rawInputIds: [raw.body.rawInputId],
    });
    await t.json('PUT', `/api/problems/${id}`, { expectedVersion: 1, blocks: [{ id: blockId, kind: 'text', body: '整理后' }] });
    const got = await t.json('GET', `/api/problems/${id}`);
    expect(got.body.rawInputs[0].text).toBe('原始粘贴  文本');

    const bytes = fakePng();
    const u1 = await uploadImage(t, bytes, 'a.png');
    const u2 = await uploadImage(t, bytes, 'b.png');
    expect(u1.asset.id).not.toBe(u2.asset.id);
    expect(u1.asset.sha256).toBe(u2.asset.sha256);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const files = fs.readdirSync(path.join(t.lib.paths.assets, sha.slice(0, 2)));
    expect(files).toEqual([`${sha}.png`]);
  });

  it('不支持的图片格式显式失败，不假装上传成功', async () => {
    t = await makeTestApp();
    const res = await t.upload('/api/uploads/image', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg');
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA');
    expect((t.lib.db.prepare('SELECT COUNT(*) AS n FROM assets').get() as { n: number }).n).toBe(0);
  });

  it('单个 .md 文件导入：保留原始字节，报告缺失的本地图片与远程图片', async () => {
    t = await makeTestApp();
    const md = '# 标题\n\n![本地](./img/a.png)\n\n![远程](https://example.com/x.png)\n\n```\n![代码里](https://example.com/code.png)\n```\n';
    const res = await t.upload('/api/uploads/text-file', Buffer.from(md), 'note.md');
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.text).toBe(md);
    expect(body.kind).toBe('markdown');
    expect(body.missingLocalImages).toEqual(['./img/a.png']);
    expect(body.remoteImageUrls).toEqual(['https://example.com/x.png']);
    const bad = await t.upload('/api/uploads/text-file', Buffer.from('x'), 'a.pdf');
    expect(bad.status).toBe(415);
  });
});
