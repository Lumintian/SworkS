/**
 * 把语义树按当前名称写回查询文本（常用检索显示与打开时用）：属性、选项与学生都按 ID 找到当前的名称，
 * 所以改名之后常用检索依然有效。已删除的选项、学生会被略去并给出提示。
 */
import type { PropTest, Q } from './ast.js';
import { specText } from './dates.js';
import { HAS_LABEL, KEY_LABEL, reservedKey, STATUS_LABEL, STUDENT_STATE_LABEL, FIELD_LABEL } from './keys.js';
import { nameKey } from './normalize.js';
import type { CatalogProperty, QueryCatalog } from './resolve.js';

const SPECIAL = /[\s"“”()（）:：,，|｜#]|\.\./u;
const LEADING = /^[-－!！><=≥≤＞＜＝]/u;

/** 需要时给值加引号（引号内的 " 与 \ 转义）。 */
export function formatValue(v: string): string {
  if (v && !SPECIAL.test(v) && !LEADING.test(v) && v !== 'OR') return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 属性的键：名称；与保留键同名时加 `属性.` 前缀；含空白等特殊字符时整个加引号。 */
export function propertyKey(def: Pick<CatalogProperty, 'name'>): string {
  const base = reservedKey(def.name) ? `属性.${def.name}` : def.name;
  return SPECIAL.test(base) || LEADING.test(base) ? `"${base.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : base;
}

export function fieldText(key: string, values: readonly string[]): string {
  return `${key}:${values.map(formatValue).join(',')}`;
}

export interface SerializeResult {
  text: string;
  /** 已删除的选项、学生等无法写回的部分 */
  problems: string[];
}

export function serializeQuery(q: Q, catalog: QueryCatalog): SerializeResult {
  const problems: string[] = [];
  const inFields = new Set<string>();
  const propById = new Map(catalog.properties.map((d) => [d.id, d]));
  const studentLabel = (id: string): string | null => {
    const s = catalog.students.find((x) => x.id === id);
    if (!s) return null;
    const dup = catalog.students.filter((x) => nameKey(x.name) === nameKey(s.name)).length > 1;
    return dup ? `${s.name}#${s.id.slice(0, 4)}` : s.name;
  };

  const propTest = (def: CatalogProperty, t: PropTest): string | null => {
    switch (t.t) {
      case 'options': {
        const paths = t.optionIds.map((id) => def.options.find((o) => o.id === id)?.path).filter((p): p is string => Boolean(p));
        if (paths.length < t.optionIds.length) problems.push(`“${def.name}”的部分选项已删除`);
        return paths.length ? paths.map(formatValue).join(',') : null;
      }
      case 'none':
        return '无';
      case 'any':
        return '*';
      case 'checked':
        return t.value ? '是' : '否';
      case 'number':
        return t.op === '=' ? String(t.value) : `${t.op}${t.value}`;
      case 'numberRange':
        return `${t.lo ?? ''}..${t.hi ?? ''}`;
      case 'date':
        return specText(t.spec);
      case 'text':
        return formatValue(t.value);
    }
  };

  const ser = (n: Q): string => {
    switch (n.k) {
      case 'true':
        return '';
      case 'false':
        problems.push(n.reason);
        return '';
      case 'and':
        return n.items.map(ser).filter(Boolean).join(' ');
      case 'or': {
        const parts = n.items.map((i) => (i.k === 'and' ? `(${ser(i)})` : ser(i))).filter((s) => s && s !== '()');
        return parts.join(' OR ');
      }
      case 'not': {
        const inner = ser(n.item);
        if (!inner) return '';
        return n.item.k === 'and' || n.item.k === 'or' ? `-(${inner})` : `-${inner}`;
      }
      case 'text': {
        if (n.via === 'in' || !n.fields) {
          for (const f of n.fields ?? []) inFields.add(FIELD_LABEL[f]);
          return formatValue(n.value);
        }
        const f = n.fields[0]!;
        const key = (Object.keys(KEY_LABEL) as (keyof typeof KEY_LABEL)[]).find((k) => k === f);
        return `${key ? KEY_LABEL[key] : FIELD_LABEL[f]}:${formatValue(n.value)}`;
      }
      case 'tag':
        return n.paths.map((p) => (SPECIAL.test(p) || LEADING.test(p) ? `标签:${formatValue(p)}` : `#${p}`)).join(' OR ');
      case 'untagged':
        return '标签:无';
      case 'dict':
        return `${KEY_LABEL[n.field]}:${n.values.map((v) => (v === null ? '无' : formatValue(v))).join(',')}`;
      case 'status':
        return `状态:${STATUS_LABEL[n.value]}`;
      case 'date':
        return `${KEY_LABEL[n.field]}:${specText(n.spec)}`;
      case 'has':
        return `有:${HAS_LABEL[n.what]}`;
      case 'student': {
        const label = studentLabel(n.studentId);
        if (!label) {
          problems.push('条件中的学生已不存在');
          return '';
        }
        return `学生:${formatValue(n.state === 'done' ? label : `${label}/${STUDENT_STATE_LABEL[n.state]}`)}`;
      }
      case 'prop': {
        const def = propById.get(n.propertyId);
        if (!def || def.archived) {
          problems.push('条件中的属性已归档或删除');
          return '';
        }
        const v = propTest(def, n.test);
        return v === null ? '' : `${propertyKey(def)}:${v}`;
      }
    }
  };

  let text = ser(q).replace(/\s+/g, ' ').trim();
  if (inFields.size) text = `${text} 范围:${[...inFields].join(',')}`.trim();
  return { text, problems };
}
