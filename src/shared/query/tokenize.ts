/**
 * 分词：记号的位置对应原文（UTF-16 下标），全角与半角符号等价。
 * - 空白含全角空格；`"…"`（支持 `\"`、`\\` 转义）或 `“…”` 是短语，未闭合时延伸到末尾并警告；
 * - `(`/`（` 只在词首开组；`)`/`）` 只在有未闭合的组、且当前词里没有未配对的 `(` 时闭组，所以 `f(x)`、`sin(2x)` 按字面处理；
 * - `OR`（仅大写）、`|`、`｜` 表示“或”；`-`、`－`、`!`、`！` 在词首且后面紧跟非空白时表示取反；
 * - `键:值`（`:` 或 `：`）是字段条件，值可以加引号；`#路径` 等于 `标签:路径`；
 *   纯数字的键（`10:30`）与 URL（`https://…`）按普通文字处理。
 */
import type { Diagnostic } from './ast.js';

export type Token =
  | { t: 'lparen' | 'rparen' | 'or' | 'neg'; from: number; to: number }
  | { t: 'word'; text: string; quoted: boolean; from: number; to: number }
  | {
      t: 'field';
      key: string;
      keyFrom: number;
      keyTo: number;
      hash: boolean;
      raw: string;
      rawFrom: number;
      rawTo: number;
      quoted: boolean;
      from: number;
      to: number;
    };

const isWs = (c: string | undefined) => c !== undefined && /\s/u.test(c);
const OPEN = new Set(['(', '（']);
const CLOSE = new Set([')', '）']);
const COLON = new Set([':', '：']);
const QUOTES = new Set(['"', '“']);
const CLOSE_QUOTES = new Set(['"', '”']);
const BAR = new Set(['|', '｜']);
const NEG = new Set(['-', '－', '!', '！']);

function readQuoted(src: string, i: number): { text: string; end: number; closed: boolean } {
  const escapes = src[i] === '"';
  let buf = '';
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (escapes && c === '\\' && j + 1 < src.length) {
      buf += src[j + 1];
      j += 2;
      continue;
    }
    if (CLOSE_QUOTES.has(c)) return { text: buf, end: j + 1, closed: true };
    buf += c;
    j++;
  }
  return { text: buf, end: src.length, closed: false };
}

export function tokenize(src: string): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let depth = 0;
  let i = 0;
  const n = src.length;
  const unclosed = (from: number) => diagnostics.push({ severity: 'warning', from, to: n, message: '引号没有闭合，已延伸到末尾' });

  /** 读取字段的值（冒号之后） */
  const fieldValue = (start: number): { raw: string; rawFrom: number; rawTo: number; quoted: boolean; end: number } => {
    if (QUOTES.has(src[start] ?? '')) {
      const q = readQuoted(src, start);
      if (!q.closed) unclosed(start);
      return { raw: q.text, rawFrom: start, rawTo: q.end, quoted: true, end: q.end };
    }
    const end = wordEnd(start);
    return { raw: src.slice(start, end), rawFrom: start, rawTo: end, quoted: false, end };
  };

  /** 普通词的结束位置：空白、`|`、或闭合外层组的 `)` */
  const wordEnd = (start: number): number => {
    let j = start;
    let balance = 0;
    while (j < n) {
      const c = src[j]!;
      if (isWs(c) || BAR.has(c)) break;
      if (OPEN.has(c)) balance++;
      else if (CLOSE.has(c)) {
        if (balance > 0) balance--;
        else if (depth > 0) break;
      }
      j++;
    }
    return j;
  };

  while (i < n) {
    const c = src[i]!;
    if (isWs(c)) {
      i++;
      continue;
    }
    if (OPEN.has(c)) {
      tokens.push({ t: 'lparen', from: i, to: i + 1 });
      depth++;
      i++;
      continue;
    }
    if (CLOSE.has(c) && depth > 0) {
      tokens.push({ t: 'rparen', from: i, to: i + 1 });
      depth--;
      i++;
      continue;
    }
    if (BAR.has(c)) {
      tokens.push({ t: 'or', from: i, to: i + 1 });
      i++;
      continue;
    }
    if (NEG.has(c) && i + 1 < n && !isWs(src[i + 1]) && !(CLOSE.has(src[i + 1]!) && depth > 0) && !BAR.has(src[i + 1]!)) {
      tokens.push({ t: 'neg', from: i, to: i + 1 });
      i++;
      continue;
    }
    if (QUOTES.has(c)) {
      const q = readQuoted(src, i);
      if (!q.closed) unclosed(i);
      // "带空格的属性名":值
      if (q.closed && COLON.has(src[q.end] ?? '') && q.text.trim()) {
        const v = fieldValue(q.end + 1);
        tokens.push({ t: 'field', key: q.text, keyFrom: i, keyTo: q.end, hash: false, ...v, from: i, to: v.end });
        i = v.end;
        continue;
      }
      tokens.push({ t: 'word', text: q.text, quoted: true, from: i, to: q.end });
      i = q.end;
      continue;
    }
    if (c === '#' && i + 1 < n && !isWs(src[i + 1])) {
      const v = fieldValue(i + 1);
      tokens.push({ t: 'field', key: '标签', keyFrom: i, keyTo: i + 1, hash: true, ...v, from: i, to: v.end });
      i = v.end;
      continue;
    }
    // 普通词或 键:值
    let colon = -1;
    for (let j = i + 1; j < n; j++) {
      const ch = src[j]!;
      if (isWs(ch) || BAR.has(ch) || OPEN.has(ch) || CLOSE.has(ch) || QUOTES.has(ch)) break;
      if (COLON.has(ch)) {
        colon = j;
        break;
      }
    }
    if (colon > 0) {
      const key = src.slice(i, colon);
      const after = src.slice(colon + 1, colon + 3);
      if (!/^\d+$/.test(key) && after !== '//') {
        const v = fieldValue(colon + 1);
        tokens.push({ t: 'field', key, keyFrom: i, keyTo: colon, hash: false, ...v, from: i, to: v.end });
        i = v.end;
        continue;
      }
    }
    const end = wordEnd(i);
    const text = src.slice(i, end);
    if (text === 'OR') tokens.push({ t: 'or', from: i, to: end });
    else tokens.push({ t: 'word', text, quoted: false, from: i, to: end });
    i = end;
  }
  return { tokens, diagnostics };
}
