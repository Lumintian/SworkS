/**
 * Markdown 中系统管理的附件引用：assets/<asset-id>.<ext>
 * 渲染器与导出器都依赖同一套解析规则。
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ASSET_REF_RE = new RegExp(`^(?:\\./)?assets/(${UUID})\\.([a-z0-9]{1,5})$`, 'i');
const UUID_RE = new RegExp(`^${UUID}$`, 'i');

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** 若 url 是受控附件引用，返回 asset id（小写）；否则返回 null。 */
export function parseAssetRef(url: string): string | null {
  const m = ASSET_REF_RE.exec(url.trim());
  return m ? m[1]!.toLowerCase() : null;
}

export function assetRef(assetId: string, ext: string): string {
  return `assets/${assetId}.${ext}`;
}

/** 只有 http/https 的绝对地址才算远程图片。 */
export function isRemoteUrl(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

export type ImageRefKind = 'asset' | 'remote' | 'other';

export function classifyImageUrl(url: string): ImageRefKind {
  if (parseAssetRef(url)) return 'asset';
  if (isRemoteUrl(url)) return 'remote';
  return 'other';
}
