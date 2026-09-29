/**
 * 对查询文本做最小的修改（条件面板、导航点击、小标签上的 ×）：删除或替换某个条件的文本范围、在末尾追加条件。
 * 用户手打的其余文字保持原样，不重新排版。
 */
import type { QueryCatalog, Scope } from './resolve.js';
import { conditionRows, type ConditionRow } from './analyze.js';
import { parseQuery } from './parse.js';

/** 删除 [from, to) 并整理两侧空白。 */
export function removeRange(text: string, from: number, to: number): string {
  const before = text.slice(0, from).replace(/\s+$/u, '');
  const after = text.slice(to).replace(/^\s+/u, '');
  return before && after ? `${before} ${after}` : before + after;
}

export function replaceRange(text: string, from: number, to: number, insert: string): string {
  if (!insert) return removeRange(text, from, to);
  return text.slice(0, from) + insert + text.slice(to);
}

export function appendCondition(text: string, cond: string): string {
  const t = text.replace(/\s+$/u, '');
  return t ? `${t} ${cond}` : cond;
}

/** 删除所有满足条件的顶层条件（从后往前删，位置不受影响）。 */
export function removeRows(text: string, rows: readonly ConditionRow[], pred: (r: ConditionRow) => boolean): string {
  let out = text;
  for (const r of [...rows].filter(pred).sort((a, b) => b.from - a.from)) out = removeRange(out, r.from, r.to);
  return out;
}

export function rowsOf(text: string, catalog: QueryCatalog, scope: Scope): ConditionRow[] {
  return conditionRows(text, parseQuery(text).ast, catalog, scope);
}

/** 两个条件是否针对同一个字段（同一保留键或同一属性） */
export function sameField(a: ConditionRow, key: { reserved?: string; propertyId?: string }): boolean {
  if (a.kind !== 'field' || !a.meaning) return false;
  if (key.reserved) return a.meaning.kind === 'reserved' && (a.meaning.key === key.reserved || (key.reserved === 'tag' && a.meaning.key === 'tag'));
  return a.meaning.kind === 'prop' && a.meaning.def.id === key.propertyId;
}

/**
 * 设置某个字段的条件：mode='replace' 先删掉同一字段的正向顶层条件再追加（单击导航）；
 * 'append' 直接追加（⌘/Ctrl+单击）；cond 为 null 时只删除。
 */
export function setFieldCondition(
  text: string,
  catalog: QueryCatalog,
  scope: Scope,
  key: { reserved?: string; propertyId?: string },
  cond: string | null,
  mode: 'replace' | 'append' = 'replace',
): string {
  let out = text;
  if (mode === 'replace' || cond === null) out = removeRows(out, rowsOf(out, catalog, scope), (r) => !r.negated && sameField(r, key));
  return cond ? appendCondition(out, cond) : out;
}
