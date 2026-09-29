/// <reference path="../types/heic-decode.d.ts" />
/**
 * 收录图片时的格式转换（只对新收录的图片；已有附件不动）：
 * - PNG（截图）→ 无损 WebP，逐像素相同，更小才采用；16 位、动画 PNG、超过 WebP 尺寸上限的保持原样；
 * - JPEG（照片）→ 按 EXIF 旋正、长边限制、有损 WebP；节省不到 minSaving 时保留原图；
 * - HEIC/HEIF（iPhone）→ libheif（WASM）解码 → 有损 WebP；AVIF → sharp 解码 → 有损 WebP；
 * - GIF、WebP 保持原样。
 * 转换后的文件去掉全部元数据（含 GPS），只保留 ICC 色彩配置；不做任何色彩转换（不改色是既有不变量）。
 * 失败时：可存储的格式原样保存并给出警告；只能输入的格式报 UNSUPPORTED_MEDIA。
 */
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import sharp, { type OutputInfo, type Sharp } from 'sharp';
import decodeHeic from 'heic-decode';
import type { ImagePolicyDTO } from '../../shared/api.js';
import { IMAGE_FORMAT_LABELS, type ImageMime, type InputImageMime } from '../../shared/constants.js';
import { AppError } from '../errors.js';
import { isAnimatedPng } from './imageSniff.js';

/** 解码时的像素上限（约 1 亿像素，防止超大图片耗尽内存） */
export const MAX_INPUT_PIXELS = 100_000_000;
/** WebP 的尺寸上限 */
const WEBP_MAX_DIMENSION = 16383;

sharp.cache(false);

export interface PreparedImage {
  data: Buffer;
  mime: ImageMime;
  /** 存下的字节与收到的不同时：原文件的格式、大小与哈希 */
  original: { mime: InputImageMime; size: number; sha256: string } | null;
  width: number | null;
  height: number | null;
  /** 没有转换成功但仍保存了原图的原因 */
  warning?: string;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function unchanged(data: Uint8Array, mime: ImageMime, width: number | null = null, height: number | null = null, warning?: string): PreparedImage {
  return { data: Buffer.from(data.buffer, data.byteOffset, data.byteLength), mime, original: null, width, height, ...(warning ? { warning } : {}) };
}

function converted(input: Uint8Array, inMime: InputImageMime, out: { data: Buffer; info: OutputInfo }): PreparedImage {
  return {
    data: out.data,
    mime: 'image/webp',
    original: { mime: inMime, size: input.byteLength, sha256: sha256(input) },
    width: out.info.width,
    height: out.info.height,
  };
}

const resize = (p: Sharp, policy: ImagePolicyDTO) =>
  policy.maxLongEdge > 0 ? p.resize({ width: policy.maxLongEdge, height: policy.maxLongEdge, fit: 'inside', withoutEnlargement: true }) : p;

// ---------------------------------------------------------------- HEIF 容器里的色彩配置

interface Box {
  type: string;
  start: number;
  end: number;
  body: number;
}

function* boxes(b: Buffer, from: number, to: number): Generator<Box> {
  let i = from;
  while (i + 8 <= to) {
    let size = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    let body = i + 8;
    if (size === 1) {
      if (i + 16 > to) return;
      size = Number(b.readBigUInt64BE(i + 8));
      body = i + 16;
    } else if (size === 0) size = to - i;
    if (size < 8 || i + size > to) return;
    yield { type, start: i, end: i + size, body };
    i += size;
  }
}

const child = (b: Buffer, parent: Box, type: string, skip = 0) => {
  for (const x of boxes(b, parent.body + skip, parent.end)) if (x.type === type) return x;
  return undefined;
};

/**
 * 读出 HEIF 的色彩描述：内嵌的 ICC（colr 的 prof/rICC），或 nclx 的色域编号（12 = Display P3）。
 * libheif（WASM 版）解码时不给出色彩配置，所以直接读容器。
 */
export function heifColour(data: Uint8Array): { icc?: Buffer; primaries?: number } {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const meta = [...boxes(b, 0, b.length)].find((x) => x.type === 'meta');
  if (!meta) return {};
  const iprp = child(b, meta, 'iprp', 4); // meta 是 FullBox：先跳过版本与标志
  const ipco = iprp && child(b, iprp, 'ipco');
  if (!ipco) return {};
  let nclx: number | undefined;
  for (const x of boxes(b, ipco.body, ipco.end)) {
    if (x.type !== 'colr' || x.body + 4 > x.end) continue;
    const kind = b.toString('latin1', x.body, x.body + 4);
    if (kind === 'prof' || kind === 'rICC') return { icc: Buffer.from(b.subarray(x.body + 4, x.end)) };
    if (kind === 'nclx' && x.body + 6 <= x.end && nclx === undefined) nclx = b.readUInt16BE(x.body + 4);
  }
  return nclx === undefined ? {} : { primaries: nclx };
}

let p3Icc: Promise<Buffer> | null = null;
/** sharp 内置的 Display P3 配置（字节） */
function displayP3Icc(): Promise<Buffer> {
  p3Icc ??= sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
    .withIccProfile('p3')
    .png()
    .toBuffer()
    .then(async (png) => (await sharp(png).metadata()).icc!);
  return p3Icc;
}

/** 在 PNG 的 IHDR 之后插入 iCCP 块：只标注色彩配置，不改变像素 */
function pngWithIcc(png: Buffer, icc: Buffer): Buffer {
  const name = Buffer.from('ICC Profile\0\0', 'latin1'); // 名称 + 结束符 + 压缩方式 0
  const body = Buffer.concat([Buffer.from('iCCP', 'latin1'), name, zlib.deflateSync(icc)]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  const ihdrEnd = 8 + 8 + 13 + 4;
  return Buffer.concat([png.subarray(0, ihdrEnd), len, body, crc, png.subarray(ihdrEnd)]);
}

// libheif 的 WASM 解码一次只做一个（内存占用大）；单张实测超过 1 秒再考虑放进 worker
let heicQueue: Promise<unknown> = Promise.resolve();
function withHeicLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = heicQueue.then(fn, fn);
  heicQueue = run.catch(() => undefined);
  return run;
}

async function heicToWebp(data: Uint8Array, mime: InputImageMime, policy: ImagePolicyDTO): Promise<PreparedImage> {
  const fail = (err?: unknown) =>
    new AppError('UNSUPPORTED_MEDIA', `无法解码 ${IMAGE_FORMAT_LABELS[mime]} 图片（文件可能已损坏，或使用了不支持的编码）；文件未保存。`, { cause: err });
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let rgba: { width: number; height: number; data: Uint8ClampedArray };
  try {
    rgba = await withHeicLock(async () => {
      const images = await decodeHeic.all({ buffer: buf });
      try {
        const first = images[0];
        if (!first) throw fail();
        if (first.width * first.height > MAX_INPUT_PIXELS) throw new AppError('TOO_LARGE', `图片像素过多（${first.width}×${first.height}）`);
        return await first.decode();
      } finally {
        images.dispose();
      }
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw fail(err);
  }
  // libheif 已经按容器里的旋转/镜像信息摆正，这里不再 rotate()
  const colour = heifColour(data);
  const icc = colour.icc ?? (colour.primaries === 12 ? await displayP3Icc() : undefined);
  const raw = sharp(Buffer.from(rgba.data.buffer, rgba.data.byteOffset, rgba.data.byteLength), { raw: { width: rgba.width, height: rgba.height, channels: 4 } });
  let pipeline: Sharp;
  if (icc) {
    const png = await raw.png({ compressionLevel: 0 }).toBuffer();
    pipeline = sharp(pngWithIcc(png, icc), { limitInputPixels: MAX_INPUT_PIXELS }).keepIccProfile();
  } else pipeline = raw;
  const out = await resize(pipeline, policy).webp({ quality: policy.photoQuality }).toBuffer({ resolveWithObject: true });
  return converted(data, mime, out);
}

/**
 * 把收到的图片整理成要存下的字节。
 * convertStorable=false 时只转换“只能输入”的格式（远程图片：URL 本身就是来源凭据，其余格式逐字节保存）。
 */
export async function prepareForStorage(
  data: Uint8Array,
  mime: InputImageMime,
  policy: ImagePolicyDTO,
  opts: { convertStorable?: boolean } = {},
): Promise<PreparedImage> {
  const convertStorable = opts.convertStorable ?? true;
  if (mime === 'image/heic' || mime === 'image/heif') return heicToWebp(data, mime, policy);
  if (mime === 'image/avif') {
    try {
      const out = await resize(sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().keepIccProfile(), policy)
        .webp({ quality: policy.photoQuality })
        .toBuffer({ resolveWithObject: true });
      return converted(data, mime, out);
    } catch (err) {
      throw new AppError('UNSUPPORTED_MEDIA', '无法解码 AVIF 图片；文件未保存。', { cause: err });
    }
  }
  if (!convertStorable || !policy.enabled || mime === 'image/gif' || mime === 'image/webp') return unchanged(data, mime);
  try {
    const meta = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    const w = meta.width ?? null;
    const h = meta.height ?? null;
    if (mime === 'image/png') {
      if (!policy.pngLossless || meta.depth !== 'uchar' || isAnimatedPng(data) || (w ?? 0) > WEBP_MAX_DIMENSION || (h ?? 0) > WEBP_MAX_DIMENSION) return unchanged(data, mime, w, h);
      const out = await sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).keepIccProfile().webp({ lossless: true, effort: 4, exact: true }).toBuffer({ resolveWithObject: true });
      return out.data.byteLength < data.byteLength ? converted(data, mime, out) : unchanged(data, mime, w, h);
    }
    // JPEG
    const out = await resize(sharp(data, { limitInputPixels: MAX_INPUT_PIXELS }).rotate().keepIccProfile(), policy)
      .webp({ quality: policy.photoQuality })
      .toBuffer({ resolveWithObject: true });
    return out.data.byteLength <= data.byteLength * (1 - policy.minSaving) ? converted(data, mime, out) : unchanged(data, mime, w, h);
  } catch (err) {
    return unchanged(data, mime, null, null, `图片未能转换，已按原格式保存（${(err as Error).message}）`);
  }
}
