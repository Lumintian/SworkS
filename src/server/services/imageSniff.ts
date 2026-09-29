import type { ImageMime, InputImageMime } from '../../shared/constants.js';

/** 识别所需的文件头长度（ftyp 的兼容品牌在前 64 字节内） */
export const SNIFF_BYTES = 64;

function ascii(b: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...b.subarray(from, to));
}

/** 依据文件头识别可存储的图片格式，不信任扩展名或 Content-Type。 */
export function sniffImage(head: Uint8Array): ImageMime | null {
  const r = sniffImageInput(head);
  return r === 'image/png' || r === 'image/jpeg' || r === 'image/webp' || r === 'image/gif' ? r : null;
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis']);
const AVIF_BRANDS = new Set(['avif', 'avis']);

/** ISO BMFF（HEIF 容器）的 ftyp：主品牌与兼容品牌 */
function ftypBrands(b: Uint8Array): { major: string; compatible: string[] } | null {
  if (b.length < 16 || ascii(b, 4, 8) !== 'ftyp') return null;
  const size = ((b[0]! << 24) >>> 0) + (b[1]! << 16) + (b[2]! << 8) + b[3]!;
  const end = Math.min(size || b.length, b.length);
  const compatible: string[] = [];
  for (let i = 16; i + 4 <= end; i += 4) compatible.push(ascii(b, i, i + 4));
  return { major: ascii(b, 8, 12), compatible };
}

/** 识别收录时接受的图片格式：可存储的四种，加上只能输入的 HEIC/HEIF/AVIF。 */
export function sniffImageInput(head: Uint8Array): InputImageMime | null {
  const b = head;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6) {
    const sig = ascii(b, 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  const ftyp = ftypBrands(b);
  if (ftyp) {
    const brands = [ftyp.major, ...ftyp.compatible];
    if (AVIF_BRANDS.has(ftyp.major)) return 'image/avif';
    if (HEIC_BRANDS.has(ftyp.major)) return 'image/heic';
    if (ftyp.major === 'mif1' || ftyp.major === 'msf1') {
      if (brands.some((x) => AVIF_BRANDS.has(x))) return 'image/avif';
      if (brands.some((x) => HEIC_BRANDS.has(x))) return 'image/heic';
      return 'image/heif';
    }
  }
  return null;
}

/** PNG 是否是动画（APNG：IDAT 之前有 acTL 块）。 */
export function isAnimatedPng(b: Uint8Array): boolean {
  let i = 8;
  while (i + 8 <= b.length) {
    const len = ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;
    const type = ascii(b, i + 4, i + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    i += 12 + len;
  }
  return false;
}

export const SUPPORTED_IMAGE_HINT = '支持 PNG、JPEG、WebP、GIF，以及 iPhone 的 HEIC/HEIF 与 AVIF（收录时转换为 WebP）';
