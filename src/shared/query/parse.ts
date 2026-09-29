/**
 * 语法分析：优先级 取反 > OR > 空格（隐式“且”），`a b OR c` = `a 且 (b 或 c)`。
 * 不抛错：语法问题（悬空的 OR、括号不配、空值）丢弃对应记号并给出警告，其余照常解析。
 * 上限：1000 字、64 个条件、嵌套 8 层、每个字段 50 个值。
 */
import type { Diagnostic, QNode, QValue } from './ast.js';
import type { CmpOp } from './dates.js';
import { tokenize, type Token } from './tokenize.js';

export const QUERY_LIMITS = { maxLength: 1000, maxAtoms: 64, maxDepth: 8, maxValues: 50 };

export interface ParseResult {
  /** null 表示空查询 */
  ast: QNode | null;
  diagnostics: Diagnostic[];
}

const OPS: [string, CmpOp][] = [
  ['>=', '>='],
  ['<=', '<='],
  ['≥', '>='],
  ['≤', '<='],
  ['>', '>'],
  ['<', '<'],
  ['=', '='],
];

/** 解析字段值：比较符、区间 a..b、逗号列表（同一字段内为“或”）。 */
function fieldValues(
  tok: Extract<Token, { t: 'field' }>,
  diags: Diagnostic[],
): { op: CmpOp | null; range: { lo: QValue | null; hi: QValue | null } | null; values: QValue[] } {
  const { raw, rawFrom, rawTo, quoted } = tok;
  if (quoted) return { op: null, range: null, values: [{ text: raw, quoted: true, from: rawFrom, to: rawTo }] };
  // 比较符（全角的 ＞＝ 经 NFKC 后与半角相同）
  let op: CmpOp | null = null;
  let skip = 0;
  for (const len of [2, 1]) {
    const head = raw.slice(0, len).normalize('NFKC');
    const hit = OPS.find(([s]) => s === head);
    if (hit) {
      op = hit[1];
      skip = len;
      break;
    }
  }
  const rest = raw.slice(skip);
  const base = rawFrom + skip;
  if (op) {
    if (!rest) return { op, range: null, values: [] };
    return { op, range: null, values: [{ text: rest, quoted: false, from: base, to: rawTo }] };
  }
  const dots = rest.indexOf('..');
  if (dots >= 0) {
    const lo = rest.slice(0, dots);
    const hi = rest.slice(dots + 2);
    if (!lo && !hi) return { op: null, range: null, values: [] };
    return {
      op: null,
      range: {
        lo: lo ? { text: lo, quoted: false, from: base, to: base + dots } : null,
        hi: hi ? { text: hi, quoted: false, from: base + dots + 2, to: rawTo } : null,
      },
      values: [],
    };
  }
  const values: QValue[] = [];
  let start = 0;
  for (let k = 0; k <= rest.length; k++) {
    if (k === rest.length || rest[k] === ',' || rest[k] === '，') {
      const text = rest.slice(start, k);
      if (text.trim()) values.push({ text, quoted: false, from: base + start, to: base + k });
      start = k + 1;
    }
  }
  if (values.length > QUERY_LIMITS.maxValues) {
    diags.push({ severity: 'warning', from: values[QUERY_LIMITS.maxValues]!.from, to: rawTo, message: `一个条件最多 ${QUERY_LIMITS.maxValues} 个值，其余已忽略` });
    values.length = QUERY_LIMITS.maxValues;
  }
  return { op: null, range: null, values };
}

export function parseQuery(input: string): ParseResult {
  const diagnostics: Diagnostic[] = [];
  let src = input;
  if (src.length > QUERY_LIMITS.maxLength) {
    diagnostics.push({ severity: 'warning', from: QUERY_LIMITS.maxLength, to: input.length, message: `查询最长 ${QUERY_LIMITS.maxLength} 字，超出部分已忽略` });
    src = src.slice(0, QUERY_LIMITS.maxLength);
  }
  const { tokens, diagnostics: tokDiags } = tokenize(src);
  diagnostics.push(...tokDiags);
  let pos = 0;
  let atoms = 0;
  let depth = 0;
  let atomLimitWarned = false;
  const peek = () => tokens[pos];
  const warn = (from: number, to: number, message: string) => diagnostics.push({ severity: 'warning', from, to, message });

  const span = (items: QNode[]) => ({ from: items[0]!.from, to: items.at(-1)!.to });

  const parseAnd = (inGroup: boolean): QNode[] => {
    const items: QNode[] = [];
    while (pos < tokens.length) {
      const t = peek()!;
      if (t.t === 'rparen') {
        if (inGroup) break;
        pos++;
        continue;
      }
      if (t.t === 'or') {
        warn(t.from, t.to, '“OR”前面缺少条件，已忽略');
        pos++;
        continue;
      }
      const item = parseOr();
      if (item) items.push(item);
    }
    return items;
  };

  const parseOr = (): QNode | null => {
    const first = parseUnary();
    const items: QNode[] = first ? [first] : [];
    while (peek()?.t === 'or') {
      const orTok = next();
      const after = peek();
      if (!after || after.t === 'rparen' || after.t === 'or') {
        warn(orTok.from, orTok.to, '“OR”后面缺少条件，已忽略');
        continue;
      }
      const right = parseUnary();
      if (right) items.push(right);
    }
    if (items.length === 0) return null;
    return items.length === 1 ? items[0]! : { type: 'or', items, ...span(items) };
  };

  const next = () => tokens[pos++]!;

  const parseUnary = (): QNode | null => {
    const t = peek();
    if (!t) return null;
    if (t.t === 'neg') {
      pos++;
      const after = peek();
      if (!after || after.t === 'rparen' || after.t === 'or') {
        warn(t.from, t.to, '取反符号后面缺少条件，已忽略');
        return null;
      }
      const inner = parseUnary();
      if (!inner) return null;
      return { type: 'not', item: inner, from: t.from, to: inner.to };
    }
    return parsePrimary();
  };

  const parsePrimary = (): QNode | null => {
    const t = next();
    if (t.t === 'lparen') {
      depth++;
      const tooDeep = depth > QUERY_LIMITS.maxDepth;
      if (tooDeep) warn(t.from, t.to, `括号最多嵌套 ${QUERY_LIMITS.maxDepth} 层`);
      const items = parseAnd(true);
      const close = peek();
      let end = items.length ? items.at(-1)!.to : t.to;
      if (close?.t === 'rparen') {
        pos++;
        end = close.to;
      } else warn(t.from, t.to, '括号没有闭合');
      depth--;
      if (items.length === 0) {
        warn(t.from, end, '空括号，已忽略');
        return null;
      }
      return items.length === 1 ? items[0]! : { type: 'and', items, from: t.from, to: end };
    }
    if (t.t === 'rparen' || t.t === 'or' || t.t === 'neg') return null;
    if (atoms >= QUERY_LIMITS.maxAtoms) {
      if (!atomLimitWarned) warn(t.from, src.length, `最多 ${QUERY_LIMITS.maxAtoms} 个条件，其余已忽略`);
      atomLimitWarned = true;
      return null;
    }
    atoms++;
    if (t.t === 'word') return { type: 'text', value: t.text, phrase: t.quoted, from: t.from, to: t.to };
    if (t.t !== 'field') return null;
    const v = fieldValues(t, diagnostics);
    if (v.values.length === 0 && !v.range) {
      warn(t.from, t.to, `“${t.key}”后面缺少值，已忽略`);
      return null;
    }
    return { type: 'field', key: t.key, keyFrom: t.keyFrom, keyTo: t.keyTo, hash: t.hash, op: v.op, range: v.range, values: v.values, from: t.from, to: t.to };
  };

  const items = parseAnd(false);
  const ast = items.length === 0 ? null : items.length === 1 ? items[0]! : { type: 'and' as const, items, ...span(items) };
  return { ast, diagnostics };
}
