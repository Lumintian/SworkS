/**
 * 渲染链配置：编辑预览、题目内容、笔记共用同一套。
 * remark-gfm + remark-math → rehype-callouts（类 Obsidian callout）→ rehype-katex。
 * 不启用原始 HTML：源码中的 HTML 以文本显示，不执行。
 */
import rehypeCallouts from 'rehype-callouts';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { visit } from 'unist-util-visit';

interface Node {
  type: string;
  tagName?: string;
  value?: string;
  children?: Node[];
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

const svg = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICON_CHECK_CIRCLE = svg('<circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path>');
const ICON_LIGHTBULB = svg(
  '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"></path><path d="M9 18h6"></path><path d="M10 22h4"></path>',
);
const ICON_LEAF = svg(
  '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"></path><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"></path>',
);

/** 未知类型使用的通用样式类型 */
export const FALLBACK_CALLOUT = 'unknown-type';

/** 常见内置类型及别名（与 rehype-callouts obsidian 主题一致）+ 本项目的 answer / solution。标题使用中文。 */
export const CALLOUT_TITLES: Record<string, string> = {
  note: '备注',
  abstract: '摘要',
  summary: '摘要',
  tldr: '摘要',
  info: '信息',
  todo: '待办',
  tip: '提示',
  hint: '提示',
  important: '重要',
  success: '完成',
  check: '完成',
  done: '完成',
  question: '问题',
  help: '帮助',
  faq: '常见问题',
  warning: '注意',
  caution: '小心',
  attention: '注意',
  failure: '失败',
  fail: '失败',
  missing: '缺失',
  danger: '危险',
  error: '错误',
  bug: '问题',
  example: '示例',
  quote: '引用',
  cite: '引用',
  answer: '答案',
  solution: '解析',
};

const KNOWN = new Set([...Object.keys(CALLOUT_TITLES), FALLBACK_CALLOUT]);

function calloutOptions() {
  const callouts: Record<string, { title?: string; indicator?: string }> = {};
  for (const [k, title] of Object.entries(CALLOUT_TITLES)) callouts[k] = { title };
  callouts.answer = { title: '答案', indicator: ICON_CHECK_CIRCLE };
  callouts.solution = { title: '解析', indicator: ICON_LIGHTBULB };
  callouts[FALLBACK_CALLOUT] = { title: '', indicator: ICON_LEAF };
  return {
    theme: 'obsidian' as const,
    callouts,
    props: {
      containerProps: (node: Node) => {
        const original = node.data?.calloutOriginalType;
        return typeof original === 'string' ? { 'data-callout-type': original } : {};
      },
    },
  };
}

const MARKER_AT_START = /^\[!([\w-]+)\]([+-]?)([^\n]*)/;

/**
 * 在 rehype-callouts 之前运行：
 * 1. 未知类型改用通用样式，并保留原始类型文本（无自定义标题时以原类型作标题）；
 * 2. 标记不在段首的引用块不应成为 callout（rehype-callouts 的正则未锚定段首）。
 */
export function rehypeCalloutFallback() {
  return (tree: Node) => {
    visit(tree as never, 'element', (raw: unknown) => {
      const node = raw as Node;
      if (node.tagName !== 'blockquote' || !node.children) return;
      const first = node.children.find((c) => !(c.type === 'text' && /^\s*$/.test(c.value ?? '')));
      if (!first || first.type !== 'element' || first.tagName !== 'p' || !first.children?.length) return;
      const text = first.children[0]!;
      if (text.type !== 'text' || typeof text.value !== 'string') return;
      const m = MARKER_AT_START.exec(text.value);
      if (!m) {
        // 不在段首的 [!xxx] 不是 callout：插入零宽字符阻止误匹配
        if (/\[![\w-]+\]/.test(text.value)) text.value = text.value.replace(/\[!(?=[\w-]+\])/g, '[​!');
        return;
      }
      const typed = m[1]!;
      if (KNOWN.has(typed.toLowerCase())) return;
      node.data = { ...node.data, calloutOriginalType: typed };
      const after = text.value.slice(m[0].length);
      const titleEmpty = m[3]!.trim() === '' && (after.startsWith('\n') || first.children.length === 1);
      text.value = `[!${FALLBACK_CALLOUT}]${m[2]}${titleEmpty ? ` ${typed}` : m[3]}${after}`;
    });
  };
}

interface MdNode extends Node {
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/**
 * 与 Obsidian 一致：独占一行的 $$...$$（可在引用/callout 内）按块级公式显示。
 * remark-math 会把写在一行里的 $$...$$ 当作行内公式；这里只改渲染方式，不改源码。
 */
export function remarkLoneDisplayMath() {
  return (tree: Node, file: { value?: unknown }) => {
    const src = typeof file.value === 'string' ? file.value : String(file.value ?? '');
    visit(tree as never, 'inlineMath', (raw: unknown) => {
      const node = raw as MdNode;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined || src.slice(start, start + 2) !== '$$') return;
      const lineStart = src.lastIndexOf('\n', start - 1) + 1;
      const lineEndIdx = src.indexOf('\n', end);
      const before = src.slice(lineStart, start);
      const after = src.slice(end, lineEndIdx === -1 ? src.length : lineEndIdx);
      if (!/^[\s>]*$/.test(before) || after.trim() !== '') return;
      const data = (node.data ??= {}) as { hProperties?: { className?: string[] } };
      data.hProperties = { ...data.hProperties, className: ['language-math', 'math-display'] };
    });
  };
}

/** 源码中的原始 HTML 以字面文本显示（不渲染、不执行）。 */
export function remarkHtmlAsText() {
  return (tree: Node) => {
    visit(tree as never, 'html', (raw: unknown) => {
      (raw as Node).type = 'text';
    });
  };
}

export const KATEX_OPTIONS = {
  throwOnError: false,
  strict: 'ignore' as const,
  errorColor: '#a5533b',
  trust: false,
  maxSize: 50,
  maxExpand: 1000,
  output: 'htmlAndMathml' as const,
};

export const REMARK_PLUGINS = [remarkGfm, remarkMath, remarkLoneDisplayMath, remarkHtmlAsText];
export const REHYPE_PLUGINS = [
  rehypeCalloutFallback,
  [rehypeCallouts, calloutOptions()],
  [rehypeKatex, KATEX_OPTIONS],
] as const;
