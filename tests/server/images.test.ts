import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_POLICY } from '../../src/shared/api.js';
import { heifColour, prepareForStorage } from '../../src/server/services/imageConvert.js';
import { isAnimatedPng, sniffImageInput } from '../../src/server/services/imageSniff.js';
import { makeTestApp, type TestApp } from '../helpers/server.js';

const HEIC = fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/images/sample-p3.heic'));

let t: TestApp | undefined;
afterEach(() => {
  t?.close();
  t = undefined;
});

/** 带噪点的渐变（有噪点，JPEG/WebP 才不至于小得反常） */
function pixels(w: number, h: number, channels = 3): Buffer {
  const b = Buffer.alloc(w * h * channels);
  let seed = 7;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * channels;
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      b[i] = (x * 255) / w;
      b[i + 1] = (y * 255) / h;
      b[i + 2] = seed % 64;
      if (channels === 4) b[i + 3] = 255;
    }
  return b;
}

const raw = (w: number, h: number, channels: 3 | 4 = 3) => sharp(pixels(w, h, channels), { raw: { width: w, height: h, channels } });

/** 在 PNG 的 IHDR 后插入一个 acTL 块（APNG 标志） */
function makeApng(png: Buffer): Buffer {
  const acTL = Buffer.from([0, 0, 0, 8, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([png.subarray(0, 33), acTL, png.subarray(33)]);
}

describe('识别格式', () => {
  it('HEIC、AVIF 按 ftyp 品牌识别；APNG 识别', async () => {
    expect(sniffImageInput(HEIC.subarray(0, 64))).toBe('image/heic');
    const avif = await raw(16, 16).avif().toBuffer();
    expect(sniffImageInput(avif.subarray(0, 64))).toBe('image/avif');
    const png = await raw(8, 8).png().toBuffer();
    expect(isAnimatedPng(png)).toBe(false);
    expect(isAnimatedPng(makeApng(png))).toBe(true);
  });
});

describe('转换规则', () => {
  const policy = DEFAULT_IMAGE_POLICY;

  it('PNG → 无损 WebP：逐像素相同，保留 ICC 且不改色', async () => {
    const png = await raw(200, 150, 4).withIccProfile('p3').png({ compressionLevel: 0 }).toBuffer();
    const r = await prepareForStorage(png, 'image/png', policy);
    expect(r.mime).toBe('image/webp');
    expect(r.original).toMatchObject({ mime: 'image/png', size: png.byteLength });
    expect(r.data.byteLength).toBeLessThan(png.byteLength);
    const [a, b] = await Promise.all([sharp(png).ensureAlpha().raw().toBuffer(), sharp(r.data).ensureAlpha().raw().toBuffer()]);
    expect(Buffer.compare(a, b)).toBe(0);
    const [ma, mb] = await Promise.all([sharp(png).metadata(), sharp(r.data).metadata()]);
    expect(Buffer.compare(ma.icc!, mb.icc!)).toBe(0);
  });

  it('16 位 PNG、APNG、超过 WebP 尺寸上限的 PNG 保持原样', async () => {
    const png16 = await raw(32, 32).toColourspace('rgb16').png().toBuffer();
    expect((await sharp(png16).metadata()).depth).toBe('ushort');
    for (const input of [png16, makeApng(await raw(32, 32).png().toBuffer()), await sharp({ create: { width: 1, height: 20000, channels: 3, background: '#abc' } }).png().toBuffer()]) {
      const r = await prepareForStorage(input, 'image/png', policy);
      expect(r.mime).toBe('image/png');
      expect(r.original).toBeNull();
      expect(Buffer.compare(r.data, input)).toBe(0);
    }
  });

  it('JPEG：按 EXIF 旋正、去掉 GPS、长边受限', async () => {
    const jpeg = await raw(4000, 1000)
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .withExifMerge({ IFD0: { Make: 'TestCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '39/1 54/1 0/1' } })
      .toBuffer();
    const inMeta = await sharp(jpeg).metadata();
    expect(inMeta.orientation).toBe(6);
    expect(inMeta.exif).toBeDefined();
    const r = await prepareForStorage(jpeg, 'image/jpeg', policy);
    expect(r.mime).toBe('image/webp');
    const m = await sharp(r.data).metadata();
    // 方向 6 = 顺时针转 90°：旋正后宽高互换，长边限制为 3072
    expect([m.width, m.height]).toEqual([768, 3072]);
    expect(m.exif).toBeUndefined();
    expect(m.orientation).toBeUndefined();
  });

  it('节省不到 10% 的 JPEG 保留原图；策略关闭时字节不变', async () => {
    const tiny = await raw(64, 64).jpeg({ quality: 40 }).toBuffer();
    const kept = await prepareForStorage(tiny, 'image/jpeg', { ...policy, minSaving: 0.9 });
    expect(kept.mime).toBe('image/jpeg');
    expect(kept.original).toBeNull();
    const png = await raw(64, 64).png({ compressionLevel: 0 }).toBuffer();
    const off = await prepareForStorage(png, 'image/png', { ...policy, enabled: false });
    expect(Buffer.compare(off.data, png)).toBe(0);
    expect(off.original).toBeNull();
  });

  it('HEIC → 有损 WebP：尺寸正确，按容器里的配置标注 Display P3', async () => {
    expect(heifColour(HEIC).icc?.byteLength).toBeGreaterThan(100);
    const r = await prepareForStorage(HEIC, 'image/heic', policy);
    expect(r.mime).toBe('image/webp');
    expect([r.width, r.height]).toEqual([96, 64]);
    expect(r.original).toMatchObject({ mime: 'image/heic', size: HEIC.byteLength });
    const m = await sharp(r.data).metadata();
    expect([m.width, m.height]).toEqual([96, 64]);
    const p3 = (await sharp(await raw(1, 1).withIccProfile('p3').png().toBuffer()).metadata()).icc!;
    expect(Buffer.compare(m.icc!, p3)).toBe(0);
    // 不改色：左上角接近原图的 (0, 0, 180)
    const px = await sharp(r.data).removeAlpha().raw().toBuffer();
    expect(px[0]).toBeLessThan(20);
    expect(Math.abs(px[2]! - 180)).toBeLessThan(20);
  });

  it('AVIF → WebP；损坏的 HEIC 明确报错', async () => {
    const avif = await raw(40, 30).avif().toBuffer();
    const r = await prepareForStorage(avif, 'image/avif', policy);
    expect(r.mime).toBe('image/webp');
    expect([r.width, r.height]).toEqual([40, 30]);
    const broken = Buffer.concat([HEIC.subarray(0, 200), Buffer.alloc(200)]);
    await expect(prepareForStorage(broken, 'image/heic', policy)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
  });
});

describe('收录与设置', () => {
  it('上传 HEIC：存成 WebP，原始输入记下原文件的格式、大小与哈希；普通 GIF 不记', async () => {
    t = await makeTestApp();
    const res = await t.upload('/api/uploads/image', HEIC, 'IMG_0001.HEIC');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { asset: { id: string; mime: string }; rawInputId: string; conversion: { from: string; to: string; originalSize: number } };
    expect(body.asset.mime).toBe('image/webp');
    expect(body.conversion).toMatchObject({ from: 'HEIC', to: 'WebP', originalSize: HEIC.byteLength });
    const row = t.lib.db.prepare('SELECT original_mime, original_size, original_sha256 FROM raw_inputs WHERE id = ?').get(body.rawInputId) as Record<string, unknown>;
    expect(row).toMatchObject({ original_mime: 'image/heic', original_size: HEIC.byteLength });
    expect(String(row.original_sha256)).toHaveLength(64);
    // 附件接口按 WebP 返回
    const img = await t.request('GET', `/api/assets/${body.asset.id}`);
    expect(img.headers.get('content-type')).toBe('image/webp');

    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#f00' } }).gif().toBuffer();
    const g = (await (await t.upload('/api/uploads/image', gif, 'a.gif')).json()) as { rawInputId: string; conversion?: unknown };
    expect(g.conversion).toBeUndefined();
    expect(t.lib.db.prepare('SELECT original_mime FROM raw_inputs WHERE id = ?').get(g.rawInputId)).toEqual({ original_mime: null });
  });

  it('图片策略可读写并校验；关闭后 PNG 原样保存', async () => {
    t = await makeTestApp();
    expect((await t.json('GET', '/api/settings/images')).body).toEqual(DEFAULT_IMAGE_POLICY);
    expect((await t.json('PUT', '/api/settings/images', { photoQuality: 10 })).status).toBe(400);
    const updated = await t.json('PUT', '/api/settings/images', { enabled: false });
    expect(updated.body.enabled).toBe(false);
    const png = await raw(64, 64).png({ compressionLevel: 0 }).toBuffer();
    const r = (await (await t.upload('/api/uploads/image', png, 'a.png')).json()) as { asset: { mime: string; size: number } };
    expect(r.asset).toMatchObject({ mime: 'image/png', size: png.byteLength });
  });
});

describe('远程图片', () => {
  let server: http.Server;
  let port = 0;
  let png: Buffer;
  beforeAll(async () => {
    png = await raw(64, 64).png({ compressionLevel: 0 }).toBuffer();
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/photo.heic')) {
        res.writeHead(200, { 'content-type': 'image/heic' });
        res.end(HEIC);
      } else if (req.url?.startsWith('/shot.png')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(png);
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

  it('远程 HEIC 转成 WebP；远程 PNG 逐字节保存', async () => {
    t = await makeTestApp({ fetchPolicy: { isAddressAllowed: (ip: string) => ip === '127.0.0.1' } });
    const heic = await t.json('POST', '/api/remote-images', { url: `http://127.0.0.1:${port}/photo.heic` });
    expect(heic.body.remoteImage.status).toBe('archived');
    expect(heic.body.asset.mime).toBe('image/webp');
    const p = await t.json('POST', '/api/remote-images', { url: `http://127.0.0.1:${port}/shot.png` });
    expect(p.body.asset).toMatchObject({ mime: 'image/png', size: png.byteLength });
    const file = t.ctx.store.absolutePath((t.lib.db.prepare('SELECT rel_path FROM assets WHERE id = ?').get(p.body.asset.id) as { rel_path: string }).rel_path);
    expect(Buffer.compare(fs.readFileSync(file), png)).toBe(0);
  });
});
