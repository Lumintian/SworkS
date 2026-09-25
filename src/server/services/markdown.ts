/**
 * 服务端 Markdown 语法树工具：与前端渲染使用同一组 remark 语法扩展（GFM + math），
 * 只用于识别“实际的图片节点”，不改写存储的源码。
 */
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { classifyImageUrl, type ImageRefKind } from '../../shared/assetRef.js';

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export interface ImageRef {
  url: string;
  kind: ImageRefKind;
  /** 'image'：![alt](url)；'definition'：被图片引用使用的 [label]: url 定义 */
  node: 'image' | 'definition';
  alt: string | null;
  title: string | null;
  start: number;
  end: number;
  label: string | null;
}

interface MdNode {
  type: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  identifier?: string;
  label?: string | null;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** 提取 Markdown 中所有图片节点（含图片引用所用的定义），代码块、行内代码和普通链接中的 URL 不计入。 */
export function extractImageRefs(md: string): ImageRef[] {
  if (!md.includes('!')) return [];
  const tree = processor.parse(md);
  const refs: ImageRef[] = [];
  const imageRefIds = new Set<string>();
  const definitions: MdNode[] = [];
  visit(tree, (raw) => {
    const node = raw as MdNode;
    if (node.type === 'image' && typeof node.url === 'string') {
      refs.push({
        url: node.url,
        kind: classifyImageUrl(node.url),
        node: 'image',
        alt: node.alt ?? null,
        title: node.title ?? null,
        start: node.position?.start.offset ?? -1,
        end: node.position?.end.offset ?? -1,
        label: null,
      });
    } else if (node.type === 'imageReference' && node.identifier) {
      imageRefIds.add(node.identifier);
    } else if (node.type === 'definition') {
      definitions.push(node);
    }
  });
  for (const def of definitions) {
    if (!def.identifier || !imageRefIds.has(def.identifier) || typeof def.url !== 'string') continue;
    refs.push({
      url: def.url,
      kind: classifyImageUrl(def.url),
      node: 'definition',
      alt: null,
      title: def.title ?? null,
      start: def.position?.start.offset ?? -1,
      end: def.position?.end.offset ?? -1,
      label: def.label ?? def.identifier,
    });
  }
  return refs;
}

export function remoteImageUrls(md: string): string[] {
  return [...new Set(extractImageRefs(md).filter((r) => r.kind === 'remote').map((r) => r.url.trim()))];
}

/** 本地相对路径图片，但不是系统管理的附件引用，例如导入的 .md 里的 ./img/a.png */
export function missingLocalImages(md: string): string[] {
  return [...new Set(extractImageRefs(md).filter((r) => r.kind === 'other').map((r) => r.url))];
}

function escapeLinkText(text: string): string {
  return text.replace(/([\\[\]])/g, '\\$1');
}

function formatDestination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>]/g, encodeURIComponent)}>` : url;
}

function formatTitle(title: string | null): string {
  return title ? ` "${title.replace(/(["\\])/g, '\\$1')}"` : '';
}

/**
 * 仅用于导出：按语法树位置替换图片地址，其余源码逐字保留。
 * resolver 返回 null 表示保持原样。
 */
export function rewriteImageUrls(md: string, resolver: (ref: ImageRef) => string | null): string {
  const refs = extractImageRefs(md)
    .filter((r) => r.start >= 0 && r.end > r.start)
    .sort((a, b) => b.start - a.start);
  let out = md;
  for (const ref of refs) {
    const next = resolver(ref);
    if (next === null || next === ref.url) continue;
    const replacement =
      ref.node === 'image'
        ? `![${escapeLinkText(ref.alt ?? '')}](${formatDestination(next)}${formatTitle(ref.title)})`
        : `[${ref.label ?? ''}]: ${formatDestination(next)}${formatTitle(ref.title)}`;
    out = out.slice(0, ref.start) + replacement + out.slice(ref.end);
  }
  return out;
}

/** 列表摘要：粗略去掉 Markdown 标记，只用于展示。 */
export function plainSummary(md: string, max = 140): string {
  const text = md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '［图片］')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+\.)\s*/gm, '')
    .replace(/\[![\w-]+\][+-]?/g, '')
    .replace(/[*_~`]/g, '')
    .replace(/\$\$?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
