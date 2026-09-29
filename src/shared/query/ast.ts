/**
 * 查询的两层结构：
 * - 语法树（QNode）：parse 的结果，保留每个记号在原文里的位置，未做名称解析；面板、高亮与编辑都基于它。
 * - 语义树（Q）：resolve 的结果，属性/选项/学生都已换成 ID、文字已规范化；服务端据此生成 SQL，
 *   常用检索也保存它（标签保存路径，日期保存原样的写法）。
 */
import type { AttemptFilter, MaterialStatus, SearchField } from '../constants.js';
import type { CmpOp, DateSpec } from './dates.js';
import type { HasWhat } from './keys.js';

export interface QValue {
  text: string;
  quoted: boolean;
  from: number;
  to: number;
}

export type QNode =
  | { type: 'and' | 'or'; items: QNode[]; from: number; to: number }
  | { type: 'not'; item: QNode; from: number; to: number }
  | { type: 'text'; value: string; phrase: boolean; from: number; to: number }
  | {
      type: 'field';
      key: string;
      keyFrom: number;
      keyTo: number;
      /** `#路径` 写法 */
      hash: boolean;
      op: CmpOp | null;
      /** `a..b` 区间（两端可空） */
      range: { lo: QValue | null; hi: QValue | null } | null;
      values: QValue[];
      from: number;
      to: number;
    };

export type Q =
  | { k: 'and' | 'or'; items: Q[] }
  | { k: 'not'; item: Q }
  | { k: 'true' }
  | { k: 'false'; reason: string }
  /** value 已规范化；fields 省略表示全部字段；via='in' 表示字段来自全局的 范围: */
  | { k: 'text'; value: string; phrase: boolean; fields?: SearchField[]; via?: 'in' }
  /** 多个路径为“或”，每个含子树 */
  | { k: 'tag'; paths: string[] }
  | { k: 'untagged' }
  /** null 表示未设置 */
  | { k: 'dict'; field: 'subject' | 'stage'; values: (string | null)[] }
  | { k: 'status'; value: MaterialStatus }
  | { k: 'prop'; propertyId: string; test: PropTest }
  | { k: 'date'; field: 'created' | 'updated'; spec: DateSpec }
  | { k: 'has'; what: HasWhat }
  | { k: 'student'; studentId: string; state: AttemptFilter };

export type PropTest =
  | { t: 'options'; optionIds: string[] }
  | { t: 'none' }
  | { t: 'any' }
  | { t: 'checked'; value: boolean }
  | { t: 'number'; op: CmpOp; value: number }
  | { t: 'numberRange'; lo: number | null; hi: number | null }
  | { t: 'date'; spec: DateSpec }
  | { t: 'text'; value: string };

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  from: number;
  to: number;
  message: string;
  suggestions?: string[];
}

export const TRUE_Q: Q = { k: 'true' };

/** 组合并化简：去掉恒真项，单项直接返回。 */
export function andQ(items: Q[]): Q {
  const flat: Q[] = [];
  for (const q of items) {
    if (q.k === 'true') continue;
    if (q.k === 'and') flat.push(...q.items);
    else flat.push(q);
  }
  if (flat.length === 0) return TRUE_Q;
  return flat.length === 1 ? flat[0]! : { k: 'and', items: flat };
}

export function orQ(items: Q[]): Q {
  const flat: Q[] = [];
  for (const q of items) {
    if (q.k === 'true') return TRUE_Q;
    if (q.k === 'or') flat.push(...q.items);
    else flat.push(q);
  }
  if (flat.length === 0) return { k: 'false', reason: '空条件' };
  return flat.length === 1 ? flat[0]! : { k: 'or', items: flat };
}

/** 遍历语义树 */
export function walkQ(q: Q, fn: (q: Q, negated: boolean) => void, negated = false): void {
  fn(q, negated);
  if (q.k === 'and' || q.k === 'or') for (const i of q.items) walkQ(i, fn, negated);
  else if (q.k === 'not') walkQ(q.item, fn, !negated);
}

/** 需要相关度与片段的正向文字条件 */
export function positiveTexts(q: Q): { value: string; phrase: boolean; fields?: SearchField[] }[] {
  const out: { value: string; phrase: boolean; fields?: SearchField[] }[] = [];
  walkQ(q, (n, neg) => {
    if (n.k === 'text' && !neg) out.push({ value: n.value, phrase: n.phrase, ...(n.fields ? { fields: n.fields } : {}) });
  });
  return out;
}

/** 自底向上改写语义树（常用检索随标签改名、字典改名同步时用）。 */
export function mapQ(q: Q, fn: (q: Q) => Q): Q {
  switch (q.k) {
    case 'and':
      return fn(andQ(q.items.map((i) => mapQ(i, fn))));
    case 'or':
      return fn(orQ(q.items.map((i) => mapQ(i, fn))));
    case 'not':
      return fn({ k: 'not', item: mapQ(q.item, fn) });
    default:
      return fn(q);
  }
}
