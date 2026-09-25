import type { ImageMime } from '../../shared/constants.js';

/** 依据文件头识别支持的图片格式，不信任扩展名或 Content-Type。 */
export function sniffImage(head: Uint8Array): ImageMime | null {
  const b = head;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return 'image/png';
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6) {
    const sig = String.fromCharCode(...b.subarray(0, 6));
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  if (b.length >= 12) {
    const riff = String.fromCharCode(...b.subarray(0, 4));
    const webp = String.fromCharCode(...b.subarray(8, 12));
    if (riff === 'RIFF' && webp === 'WEBP') return 'image/webp';
  }
  return null;
}

export const SUPPORTED_IMAGE_HINT = '仅支持 PNG、JPEG、WebP、GIF 图片';
