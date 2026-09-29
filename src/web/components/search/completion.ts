/** 查询输入框的自动补全：键名（附中文说明）与各字段的取值（选项路径、标签、学生、学科学段、日期快捷词）。 */
import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import {
  DATE_SHORTCUTS,
  FIELD_LABEL,
  formatValue,
  HAS_LABEL,
  KEY_HINT,
  KEY_LABEL,
  keyMeaning,
  propertyKey,
  STUDENT_STATE_LABEL,
  tokenize,
  type ReservedKey,
  type Scope,
} from '@shared/query';
import { splitTagPath, TAG_SEP } from '@shared/tagPath';
import type { QueryContext } from '../../lib/queryText';

const MATERIAL_ONLY: ReservedKey[] = ['status'];
const PROBLEM_ONLY: ReservedKey[] = ['note', 'answer', 'solution', 'student'];

function keyOptions(ctx: QueryContext, scope: Scope): Completion[] {
  const reserved = (Object.keys(KEY_LABEL) as ReservedKey[])
    .filter((k) => !(scope === 'problem' ? MATERIAL_ONLY : PROBLEM_ONLY).includes(k))
    .map((k): Completion => ({ label: `${KEY_LABEL[k]}:`, detail: KEY_HINT[k], type: 'keyword', apply: `${KEY_LABEL[k]}:` }));
  const props = ctx.catalog.properties
    .filter((d) => (scope === 'problem' ? d.appliesProblem : d.appliesMaterial))
    .map((d): Completion => ({ label: `${propertyKey(d)}:`, detail: '属性', type: 'property', apply: `${propertyKey(d)}:`, boost: 1 }));
  return [...props, ...reserved];
}

function allTagPaths(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const segs = splitTagPath(n);
    for (let i = 1; i <= segs.length; i++) out.add(segs.slice(0, i).join(TAG_SEP));
  }
  return [...out].sort((a, b) => a.localeCompare(b, 'zh'));
}

function valueOptions(ctx: QueryContext, scope: Scope, key: string, hash: boolean, typed: string): { label: string; detail?: string }[] {
  const m = keyMeaning(ctx.qc, key, hash);
  const words = (xs: readonly string[], detail?: string) => xs.map((label) => ({ label, ...(detail ? { detail } : {}) }));
  if (m.kind === 'unknown') return [];
  if (m.kind === 'prop') {
    const def = ctx.catalog.properties.find((d) => d.id === m.def.id);
    if (!def) return [];
    if (def.type === 'select' || def.type === 'multiselect') return [...words(def.options.map((o) => o.path)), ...words(['无'], '未设置'), ...words(['*'], '已设置')];
    if (def.type === 'checkbox') return words(['是', '否']);
    if (def.type === 'date') return [...words(DATE_SHORTCUTS), ...words(['无'], '未设置')];
    return [...words(['无'], '未设置'), ...words(['*'], '已设置')];
  }
  switch (m.key) {
    case 'tag':
      return [...words(allTagPaths(ctx.catalog.tags.map((t) => t.name))), ...(hash ? [] : words(['无'], '没有标签'))];
    case 'subject':
      return [...words(ctx.catalog.subjects), ...words(['无'], '未设置')];
    case 'stage':
      return [...words(ctx.catalog.stages), ...words(['无'], '未设置')];
    case 'status':
      return scope === 'material' ? words(['待整理', '已整理']) : [];
    case 'student': {
      const slash = typed.lastIndexOf('/');
      if (slash > 0) return words(Object.values(STUDENT_STATE_LABEL).map((s) => `${typed.slice(0, slash)}/${s}`));
      return ctx.students.filter((s) => !s.archived).map((s) => ({ label: s.name, detail: '做过的题；可接 /错过 等' }));
    }
    case 'created':
    case 'updated':
      return words(DATE_SHORTCUTS);
    case 'has':
      return [...words(Object.values(HAS_LABEL)), ...words(ctx.catalog.properties.map((d) => d.name), '属性已设置')];
    case 'in':
      return words(Object.values(FIELD_LABEL));
    default:
      return [];
  }
}

export function queryCompletions(getCtx: () => QueryContext, getScope: () => Scope) {
  return (cc: CompletionContext): CompletionResult | null => {
    const text = cc.state.doc.toString();
    const pos = cc.pos;
    const ctx = getCtx();
    const scope = getScope();
    const tok = tokenize(text).tokens.find((t) => t.from < pos && pos <= t.to);
    if (tok?.t === 'field' && pos > tok.keyTo) {
      // 值：逗号后的这一段
      const valueText = text.slice(tok.rawFrom, pos);
      const comma = Math.max(valueText.lastIndexOf(','), valueText.lastIndexOf('，'));
      const from = comma >= 0 ? tok.rawFrom + comma + 1 : tok.rawFrom;
      const typed = text.slice(from, pos).replace(/^["“]/u, '');
      const opts = valueOptions(ctx, scope, tok.key, tok.hash, typed);
      if (!opts.length) return null;
      return {
        from,
        options: opts.map((o) => ({ label: o.label, ...(o.detail ? { detail: o.detail } : {}), apply: formatValue(o.label), type: 'constant' })),
        filter: true,
      };
    }
    if (tok?.t === 'word' && !tok.quoted) {
      if (tok.text.startsWith('#')) {
        const opts = valueOptions(ctx, scope, '标签', true, tok.text.slice(1));
        return { from: tok.from + 1, options: opts.map((o) => ({ label: o.label, apply: formatValue(o.label), type: 'constant' })) };
      }
      if (!cc.explicit && pos - tok.from < 1) return null;
      return { from: tok.from, options: keyOptions(ctx, scope), validFor: /^[^\s:：]*$/u };
    }
    if (!tok && cc.explicit) return { from: pos, options: keyOptions(ctx, scope) };
    return null;
  };
}
