/**
 * 命中片段：只为当前页生成。从原文取各字段文字 → 带位置映射地规范化 → 找出所有正向文字条件的命中 →
 * 每个对象最多 2 条（按 字段权重 × 命中的条件数，标题已在列表里显示所以跳过）→ 命中处前后各取 36 字、折叠空白 →
 * 高亮区间换算回片段文字。
 */
import type { SnippetDTO } from '../../../shared/api.js';
import type { SearchField } from '../../../shared/constants.js';
import { FIELD_WEIGHT } from '../../../shared/query/keys.js';
import { normalizeWithMap, toOriginalRange } from '../../../shared/query/normalize.js';
import type { FieldText } from './index.js';

export interface SnippetAtom {
  value: string;
  fields?: readonly SearchField[] | undefined;
}

const CONTEXT = 36;
const MAX_PER_ITEM = 2;

function mergeRanges(rs: [number, number][]): [number, number][] {
  const sorted = [...rs].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** 截取原文 [start, end) 并折叠空白，返回片段与原文位置 → 片段位置的换算。 */
function excerpt(text: string, start: number, end: number): { out: string; pos: (i: number) => number } {
  const map = new Map<number, number>();
  let out = start > 0 ? '…' : '';
  let space = false;
  for (let i = start; i < end; i++) {
    const c = text[i]!;
    if (/\s/u.test(c)) {
      space = true;
      map.set(i, out.length);
      continue;
    }
    if (space && out && out !== '…') out += ' ';
    space = false;
    map.set(i, out.length);
    out += c;
  }
  if (end < text.length) out += '…';
  return { out, pos: (i) => map.get(i) ?? out.length };
}

export function makeSnippets(texts: readonly FieldText[], atoms: readonly SnippetAtom[]): SnippetDTO[] {
  if (atoms.length === 0) return [];
  const candidates: (SnippetDTO & { score: number })[] = [];
  for (const ft of texts) {
    if (ft.field === 'title') continue;
    const m = normalizeWithMap(ft.text);
    const hits: [number, number][] = [];
    let matched = 0;
    for (const a of atoms) {
      if (!a.value || (a.fields && !a.fields.includes(ft.field))) continue;
      let from = 0;
      let any = false;
      for (;;) {
        const at = m.norm.indexOf(a.value, from);
        if (at < 0) break;
        hits.push(toOriginalRange(m, at, at + a.value.length));
        any = true;
        from = at + Math.max(a.value.length, 1);
      }
      if (any) matched++;
    }
    if (hits.length === 0) continue;
    const first = hits.reduce((x, y) => (y[0] < x[0] ? y : x));
    const start = Math.max(0, first[0] - CONTEXT);
    const end = Math.min(ft.text.length, first[1] + CONTEXT);
    const ex = excerpt(ft.text, start, end);
    const ranges = mergeRanges(hits.filter(([a, b]) => a >= start && b <= end).map(([a, b]): [number, number] => [ex.pos(a), ex.pos(b - 1) + 1]));
    candidates.push({ field: ft.field, text: ex.out, ranges, score: FIELD_WEIGHT[ft.field] * matched });
  }
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PER_ITEM)
    .map(({ field, text, ranges }) => ({ field, text, ranges }));
}
