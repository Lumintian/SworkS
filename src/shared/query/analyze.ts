/**
 * 把查询拆成“顶层条件”：条件面板每行一个，导航据此高亮当前选中的节点。
 * 只拆顶层的“且”；OR、括号组等复杂条件整体算一行“自定义表达式”。
 */
import type { AttemptFilter } from '../constants.js';
import type { Q, QNode } from './ast.js';
import { keyMeaning, resolveQuery, type KeyMeaning, type QueryCatalog, type Scope } from './resolve.js';

export interface ConditionRow {
  /** 在查询文本里的范围（含取反符号） */
  from: number;
  to: number;
  negated: boolean;
  kind: 'field' | 'text' | 'complex';
  /** kind 为 field 时：语法节点与键的含义 */
  node?: Extract<QNode, { type: 'field' }>;
  meaning?: KeyMeaning;
  /** 这一行单独解析的语义（用于导航高亮） */
  q: Q;
}

export function topLevelNodes(ast: QNode | null): QNode[] {
  if (!ast) return [];
  return ast.type === 'and' ? ast.items : [ast];
}

export function conditionRows(src: string, ast: QNode | null, catalog: QueryCatalog, scope: Scope): ConditionRow[] {
  return topLevelNodes(ast).map((n): ConditionRow => {
    const negated = n.type === 'not' && (n.item.type === 'field' || n.item.type === 'text');
    const inner = negated ? (n as Extract<QNode, { type: 'not' }>).item : n;
    const q = resolveQuery(src, n, catalog, scope).q;
    if (inner.type === 'field') return { from: n.from, to: n.to, negated, kind: 'field', node: inner, meaning: keyMeaning(catalog, inner.key, inner.hash), q };
    if (inner.type === 'text') return { from: n.from, to: n.to, negated, kind: 'text', q };
    return { from: n.from, to: n.to, negated: false, kind: 'complex', q };
  });
}

/** 导航高亮：顶层、正向的条件 */
export interface NavSelection {
  tagPaths: string[];
  untagged: boolean;
  subject: (string | null)[];
  stage: (string | null)[];
  /** 属性 ID → 选中的选项 ID（含 '__none__'、'__true__'） */
  props: Map<string, Set<string>>;
  student: { id: string; state: AttemptFilter } | null;
}

export function navSelection(rows: readonly ConditionRow[]): NavSelection {
  const sel: NavSelection = { tagPaths: [], untagged: false, subject: [], stage: [], props: new Map(), student: null };
  const visit = (q: Q) => {
    switch (q.k) {
      case 'or':
        q.items.forEach(visit);
        break;
      case 'tag':
        sel.tagPaths.push(...q.paths);
        break;
      case 'untagged':
        sel.untagged = true;
        break;
      case 'dict':
        sel[q.field].push(...q.values);
        break;
      case 'prop': {
        const set = sel.props.get(q.propertyId) ?? new Set<string>();
        if (q.test.t === 'options') q.test.optionIds.forEach((id) => set.add(id));
        else if (q.test.t === 'none') set.add('__none__');
        else if (q.test.t === 'checked' && q.test.value) set.add('__true__');
        sel.props.set(q.propertyId, set);
        break;
      }
      case 'student':
        if (!sel.student) sel.student = { id: q.studentId, state: q.state };
        break;
      default:
        break;
    }
  };
  for (const r of rows) if (!r.negated && r.kind === 'field') visit(r.q);
  return sel;
}
