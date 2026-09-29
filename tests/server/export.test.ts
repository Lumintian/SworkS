import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakePng, makeTempDir, makeTestApp, newId, uploadImage, type TestApp } from '../helpers/server.js';
import { readZip } from '../helpers/zip.js';

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

async function exportZip(t: TestApp, ids: string[]) {
  const res = await t.request('POST', '/api/export/markdown', { problemIds: ids });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/zip');
  const dir = await makeTempDir('sworks-export-test-');
  const file = path.join(dir, 'export.zip');
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const entries = await readZip(file);
  return new Map(entries.map((e) => [e.name, e.data]));
}

describe('开放 Markdown 导出', () => {
  it('无标题题目安全命名；文本、公式、callout 源码保留；相对图片有效', async () => {
    t = await makeTestApp();
    const img = await uploadImage(t, fakePng(), 'a.png');
    const inline = await uploadImage(t, fakePng(), 'b.png');
    const unrelated = await uploadImage(t, fakePng(), 'c.png');
    const id = newId();
    const callout = '> [!answer]- 展开参考答案\n> $$\\sum_{k=1}^n k = \\frac{n(n+1)}{2}$$';
    await t.json('POST', '/api/problems', {
      id,
      tags: ['数列'],
      blocks: [
        { id: newId(), kind: 'image', assetId: img.asset.id, caption: '原题截图' },
        { id: newId(), kind: 'markdown', body: `求和 $S_n$。\n\n![](assets/${inline.asset.id}.png)` },
        { id: newId(), kind: 'text', body: '字面文本 ``` # 不是标题 **x**' },
      ],
      notes: [
        { id: newId(), type: 'answer', bodyMd: callout },
        { id: newId(), type: 'solution', title: '我的解法', bodyMd: '错位相减' },
        { id: newId(), type: 'answer', bodyMd: '第二问', seq: 2 },
      ],
    });
    // 另一道题的私人笔记与图片不应被导出
    await t.json('POST', '/api/problems', {
      id: newId(),
      blocks: [{ id: newId(), kind: 'image', assetId: unrelated.asset.id }],
      notes: [{ id: newId(), type: 'note', bodyMd: '其他题的私人笔记' }],
    });
    const files = await exportZip(t, [id]);
    const mdName = `sworks-export/problem-${id}.md`;
    expect([...files.keys()].sort()).toEqual(
      [mdName, `sworks-export/assets/${img.asset.id}.png`, `sworks-export/assets/${inline.asset.id}.png`, 'sworks-export/README.md'].sort(),
    );
    const md = files.get(mdName)!.toString('utf8');
    expect(md).toContain(`id: ${id}`);
    expect(md).toContain('title: null');
    expect(md).toContain('tags: ["数列"]');
    expect(md).toContain(`![原题截图](assets/${img.asset.id}.png)`);
    expect(md).toContain(`![](assets/${inline.asset.id}.png)`);
    expect(md).toContain('````text\n字面文本 ``` # 不是标题 **x**\n````');
    expect(md).toContain(callout);
    expect(md).toContain('### 答案');
    expect(md).toContain('### 解析：我的解法');
    // 笔记按类型分节：解析在答案之前；带序号的写进标题与注释
    expect(md.indexOf('## 解析')).toBeGreaterThan(-1);
    expect(md.indexOf('## 解析')).toBeLessThan(md.indexOf('## 答案'));
    expect(md).toContain('### 答案 (2)');
    expect(md).toMatch(/<!-- sworks-note id=[0-9a-f-]+ type=answer seq=2 -->/);
    expect(md).not.toContain('其他题的私人笔记');
    // 图片字节与原件一致
    const original = fs.readFileSync(path.join(t.lib.paths.assets, `${img.asset.sha256.slice(0, 2)}/${img.asset.sha256}.png`));
    expect(files.get(`sworks-export/assets/${img.asset.id}.png`)!.equals(original)).toBe(true);
    // 导出不改写标题
    const row = t.lib.db.prepare('SELECT title FROM problems WHERE id = ?').get(id) as { title: string | null };
    expect(row.title).toBeNull();
  });

  it('有标题时使用安全文件名；未归档图片输出原 URL 与警告', async () => {
    t = await makeTestApp();
    const failed = await t.json('POST', '/api/remote-images', { url: 'http://10.0.0.1/x.png' });
    expect(failed.body.remoteImage.status).toBe('failed');
    const id = newId();
    await t.json('POST', '/api/problems', {
      id,
      title: '../../etc/passwd: <危险> 标题?*',
      blocks: [
        { id: newId(), kind: 'image', remoteImageId: failed.body.remoteImage.id },
        { id: newId(), kind: 'markdown', body: '![远程](http://10.0.0.2/y.png)' },
      ],
    });
    const files = await exportZip(t, [id]);
    const names = [...files.keys()];
    const md = names.find((n) => n.endsWith('.md') && !n.endsWith('README.md'))!;
    expect(md.startsWith('sworks-export/')).toBe(true);
    expect(md.slice('sworks-export/'.length)).not.toMatch(/[/\\<>:"|?*]/);
    expect(md).toContain(id);
    const content = files.get(md)!.toString();
    expect(content).toContain('http://10.0.0.1/x.png');
    expect(content).toContain('[!warning] 图片未归档');
    const readme = files.get('sworks-export/README.md')!.toString();
    expect(readme).toContain('并非完全离线');
    expect(readme).toContain('http://10.0.0.2/y.png');
    expect(Number((await t.request('POST', '/api/export/markdown', { problemIds: [id] })).headers.get('x-sworks-export-warnings'))).toBeGreaterThan(0);
  });

  it('导出多题；已删除题目不能导出', async () => {
    t = await makeTestApp();
    const a = newId();
    const b = newId();
    await t.json('POST', '/api/problems', { id: a, blocks: [{ id: newId(), kind: 'markdown', body: 'A' }] });
    await t.json('POST', '/api/problems', { id: b, title: '同名', blocks: [] });
    const files = await exportZip(t, [a, b]);
    expect(files.has(`sworks-export/problem-${a}.md`)).toBe(true);
    expect(files.has(`sworks-export/同名-${b}.md`)).toBe(true);
    await t.request('DELETE', `/api/problems/${a}`);
    expect((await t.request('POST', '/api/export/markdown', { problemIds: [a] })).status).toBe(404);
  });
});

describe('导出属性', () => {
  it('front matter 写入属性：单选为值、多选为列表、层级选项为路径、数字不加引号', async () => {
    t = await makeTestApp();
    const defs = (await t.json('GET', '/api/properties')).body as { id: string; preset: string | null; options: { id: string; label: string }[] }[];
    const diff = defs.find((d) => d.preset === 'difficulty')!;
    const kp = defs.find((d) => d.preset === 'knowledge')!;
    const mono = (await t.json('POST', `/api/properties/${kp.id}/options/ensure-path`, { path: '函数/单调性' })).body.optionId;
    const year = (await t.json('POST', '/api/properties', { id: newId(), name: '年份', type: 'number' })).body;
    const id = newId();
    await t.json('POST', '/api/problems', {
      id,
      blocks: [{ id: newId(), kind: 'markdown', body: '题干' }],
      properties: [
        { propertyId: diff.id, optionIds: [diff.options.find((o) => o.label === '较难')!.id] },
        { propertyId: kp.id, optionIds: [mono] },
        { propertyId: year.id, number: 2024 },
      ],
    });
    const md = (await exportZip(t, [id])).get(`sworks-export/problem-${id}.md`)!.toString('utf8');
    expect(md).toContain('"难度": "较难"');
    expect(md).toContain('"考点": ["函数/单调性"]');
    expect(md).toContain('"年份": 2024');
  });

  it('导出不包含学生与作答记录', async () => {
    t = await makeTestApp();
    const id = newId();
    await t.json('POST', '/api/problems', { id, blocks: [{ id: newId(), kind: 'markdown', body: '题干' }] });
    const sid = newId();
    await t.json('POST', '/api/students', { id: sid, name: '隐私学生' });
    await t.json('POST', '/api/attempts', { id: newId(), studentId: sid, problemId: id, result: 'wrong', note: '私人作答备注' });
    const files = await exportZip(t, [id]);
    const all = [...files.values()].map((b) => b.toString('utf8')).join('\n');
    expect(all).not.toContain('隐私学生');
    expect(all).not.toContain('私人作答备注');
  });
});
