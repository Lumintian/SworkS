import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isPublicAddress, downloadImage } from '../../src/server/services/remoteFetch.js';
import { fakePng, makeTempDir, makeTestApp, newId, PNG_1X1, type TestApp } from '../helpers/server.js';
import path from 'node:path';

let server: http.Server;
let port = 0;
const hits: string[] = [];
let brokenFixed = false;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    hits.push(url);
    if (url.startsWith('/ok.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_1X1);
    } else if (url.startsWith('/big.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(fakePng(4096));
    } else if (url.startsWith('/page.html')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html></html>');
    } else if (url.startsWith('/fake.png')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end('not really a png');
    } else if (url.startsWith('/broken.png')) {
      if (brokenFixed) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG_1X1);
      } else {
        res.writeHead(404);
        res.end();
      }
    } else if (url.startsWith('/redirect-private')) {
      res.writeHead(302, { location: `http://127.0.0.2:${port}/ok.png` });
      res.end();
    } else if (url.startsWith('/redirect-ok')) {
      res.writeHead(301, { location: '/ok.png?via=redirect' });
      res.end();
    } else if (url.startsWith('/loop')) {
      const n = Number(new URL(url, 'http://x').searchParams.get('n') ?? 0);
      res.writeHead(302, { location: `/loop?n=${n + 1}` });
      res.end();
    } else if (url.startsWith('/hang')) {
      // 不响应，测试超时
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

/** 测试策略：只允许 127.0.0.1（模拟“公网”），其余一律按非公网拒绝；域名解析可注入。 */
const testPolicy = {
  isAddressAllowed: (ip: string) => ip === '127.0.0.1',
  resolve: async (host: string) => {
    if (host === 'img.test') return [{ address: '127.0.0.1', family: 4 as const }];
    if (host === 'internal.test') return [{ address: '10.0.0.8', family: 4 as const }];
    if (host === 'mixed.test') return [{ address: '127.0.0.1', family: 4 as const }, { address: '192.168.1.2', family: 4 as const }];
    throw new Error('ENOTFOUND');
  },
};

const base = () => `http://127.0.0.1:${port}`;

describe('远程图片归档', () => {
  it('图片 URL：下载、校验、保存本地副本；原始 URL 单独保留；断网后本地副本可读', async () => {
    t = await makeTestApp({ fetchPolicy: testPolicy });
    const url = `http://img.test:${port}/ok.png?sig=secret`;
    const res = await t.json('POST', '/api/remote-images', { url });
    expect(res.status).toBe(201);
    expect(res.body.remoteImage.status).toBe('archived');
    expect(res.body.remoteImage.url).toBe(url);
    expect(res.body.asset.mime).toBe('image/png');
    const raw = t.lib.db.prepare('SELECT * FROM raw_inputs WHERE id = ?').get(res.body.rawInputId) as { url: string };
    expect(raw.url).toBe(url);
    // 图片块引用远程记录，保存题目
    const id = newId();
    const saved = await t.json('POST', '/api/problems', {
      id,
      blocks: [{ id: newId(), kind: 'image', remoteImageId: res.body.remoteImage.id }],
    });
    expect(saved.body.entity.remoteImages[res.body.remoteImage.id].assetId).toBe(res.body.asset.id);
    // “断网”：关闭远端服务器前读取的副本来自本地
    const img = await t.request('GET', `/api/assets/${res.body.asset.id}`);
    expect(Buffer.from(await img.arrayBuffer()).equals(PNG_1X1)).toBe(true);
  });

  it('下载失败保留 URL 且明确标记未归档；题目照常保存；重试与手动补传', async () => {
    t = await makeTestApp({ fetchPolicy: testPolicy });
    brokenFixed = false;
    const url = `${base()}/broken.png`;
    const res = await t.json('POST', '/api/remote-images', { url });
    expect(res.status).toBe(201);
    expect(res.body.remoteImage.status).toBe('failed');
    expect(res.body.remoteImage.errorCode).toBe('DOWNLOAD_FAILED');
    expect(res.body.remoteImage.errorMessage).toContain('404');
    expect(res.body.asset).toBeNull();
    const pid = newId();
    const saved = await t.json('POST', '/api/problems', {
      id: pid,
      blocks: [{ id: newId(), kind: 'image', remoteImageId: res.body.remoteImage.id }],
    });
    expect(saved.status).toBe(201);
    expect(saved.body.entity.remoteImages[res.body.remoteImage.id].status).toBe('failed');

    brokenFixed = true;
    const retry = await t.json('POST', `/api/remote-images/${res.body.remoteImage.id}/retry`);
    expect(retry.body.status).toBe('archived');
    expect(retry.body.attempts).toBe(2);

    // 手动补传
    const other = await t.json('POST', '/api/remote-images', { url: `${base()}/nope.png` });
    expect(other.body.remoteImage.status).toBe('failed');
    const manual = await t.upload(`/api/remote-images/${other.body.remoteImage.id}/manual`, fakePng(), 'manual.png');
    const mbody = (await manual.json()) as { status: string; archivedVia: string; url: string };
    expect(mbody.status).toBe('archived');
    expect(mbody.archivedVia).toBe('manual');
    expect(mbody.url).toBe(`${base()}/nope.png`);
  });

  it('Markdown 中实际图片节点的远程链接被归档；代码块和普通链接里的 URL 不触发下载', async () => {
    t = await makeTestApp({ fetchPolicy: testPolicy });
    hits.length = 0;
    const md = [
      `![图](${base()}/ok.png?md=1)`,
      '',
      '```',
      `![代码](${base()}/ok.png?code=1)`,
      '```',
      '',
      `\`![行内代码](${base()}/ok.png?inline=1)\``,
      '',
      `[普通链接](${base()}/ok.png?link=1)`,
      '',
      `![引用式][r]`,
      '',
      `[r]: ${base()}/ok.png?ref=1`,
    ].join('\n');
    const pid = newId();
    await t.json('POST', '/api/problems', {
      id: pid,
      blocks: [],
      notes: [{ id: newId(), type: 'answer', bodyMd: md }],
    });
    await t.ctx.archiver.idle();
    expect(hits.filter((h) => h.includes('md=1'))).toHaveLength(1);
    expect(hits.filter((h) => h.includes('ref=1'))).toHaveLength(1);
    expect(hits.filter((h) => h.includes('code=1') || h.includes('inline=1') || h.includes('link=1'))).toHaveLength(0);
    const got = await t.json('GET', `/api/problems/${pid}`);
    const rid = got.body.remoteImageUrls[`${base()}/ok.png?md=1`];
    expect(got.body.remoteImages[rid].status).toBe('archived');
    // 源码不被改写
    expect(got.body.notes[0].bodyMd).toBe(md);
  });

  it('重定向每一跳重新校验；超过次数失败；允许的重定向成功', async () => {
    t = await makeTestApp({ fetchPolicy: testPolicy });
    const blocked = await t.json('POST', '/api/remote-images', { url: `${base()}/redirect-private` });
    expect(blocked.body.remoteImage.status).toBe('failed');
    expect(blocked.body.remoteImage.errorCode).toBe('DOWNLOAD_BLOCKED');
    const loop = await t.json('POST', '/api/remote-images', { url: `${base()}/loop?n=0` });
    expect(loop.body.remoteImage.errorMessage).toContain('重定向');
    const ok = await t.json('POST', '/api/remote-images', { url: `${base()}/redirect-ok` });
    expect(ok.body.remoteImage.status).toBe('archived');
  });

  it('非图片内容、伪装图片、超过大小上限、超时都明确失败', async () => {
    t = await makeTestApp({ fetchPolicy: { ...testPolicy, maxBytes: 1000, timeoutMs: 800 } });
    const html = await t.json('POST', '/api/remote-images', { url: `${base()}/page.html` });
    expect(html.body.remoteImage.errorCode).toBe('UNSUPPORTED_MEDIA');
    const fake = await t.json('POST', '/api/remote-images', { url: `${base()}/fake.png` });
    expect(fake.body.remoteImage.errorCode).toBe('UNSUPPORTED_MEDIA');
    const big = await t.json('POST', '/api/remote-images', { url: `${base()}/big.png` });
    expect(big.body.remoteImage.errorCode).toBe('TOO_LARGE');
    const hang = await t.json('POST', '/api/remote-images', { url: `${base()}/hang` });
    expect(hang.body.remoteImage.errorMessage).toContain('超时');
  });

  it('非法图片下载目标被拦截（默认公网策略）', async () => {
    const dir = await makeTempDir();
    const dest = (n: string) => path.join(dir, n);
    const policy = { maxBytes: 1024 * 1024, timeoutMs: 2000, maxRedirects: 3 };
    const targets = [
      `http://127.0.0.1:${port}/ok.png`,
      `http://localhost:${port}/ok.png`,
      'http://10.1.2.3/a.png',
      'http://192.168.0.1/a.png',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/a.png',
      'http://[::ffff:127.0.0.1]/a.png',
      'http://0x7f000001/a.png',
      'http://2130706433/a.png',
      'http://100.64.0.1/a.png',
      'http://0.0.0.0/a.png',
      'http://[fd00::1]/a.png',
      'http://[fe80::1]/a.png',
    ];
    let i = 0;
    for (const url of targets) {
      await expect(downloadImage(url, policy, dest(`x${i++}`)), url).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
    }
    await expect(downloadImage('file:///etc/passwd', policy, dest('f'))).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
    await expect(downloadImage('ftp://example.com/a.png', policy, dest('g'))).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
    await expect(downloadImage('http://user:pw@example.com/a.png', policy, dest('h'))).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
    // 域名解析到内网或混合地址
    await expect(downloadImage('http://internal.test/a.png', { ...policy, ...testPolicy }, dest('i'))).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
    await expect(downloadImage('http://mixed.test/a.png', { ...policy, ...testPolicy }, dest('j'))).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
  });

  it('fake-ip DNS 段默认拒绝并给出提示；显式开启后只额外放行 198.18.0.0/15', async () => {
    const dir = await makeTempDir();
    const base = { maxBytes: 1024, timeoutMs: 2000, maxRedirects: 0 };
    const resolve = async (host: string) =>
      host === 'fake.test' ? [{ address: '198.18.3.7', family: 4 as const }] : [{ address: '10.0.0.1', family: 4 as const }];
    await expect(downloadImage('http://fake.test/a.png', { ...base, resolve }, path.join(dir, 'a'))).rejects.toMatchObject({
      code: 'DOWNLOAD_BLOCKED',
      message: expect.stringContaining('--allow-fake-ip-dns'),
    });
    // 开启后通过地址校验（随后因无法连接而失败，但不再是 DOWNLOAD_BLOCKED）
    const err = await downloadImage('http://fake.test/a.png', { ...base, timeoutMs: 300, resolve, allowFakeIpRange: true }, path.join(dir, 'b')).catch((e) => e);
    expect(err.code).not.toBe('DOWNLOAD_BLOCKED');
    // 其他非公网地址仍然拒绝
    await expect(downloadImage('http://lan.test/a.png', { ...base, resolve, allowFakeIpRange: true }, path.join(dir, 'c'))).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
    await expect(downloadImage('http://127.0.0.1/a.png', { ...base, allowFakeIpRange: true }, path.join(dir, 'd'))).rejects.toMatchObject({ code: 'DOWNLOAD_BLOCKED' });
  });

  it('公网地址分类', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.1.1', '0.0.0.0', '255.255.255.255', '224.0.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1', '64:ff9b::a00:1', '2002:a00:1::1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});
