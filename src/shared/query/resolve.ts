/**
 * 名称解析：把语法树里的键、属性名、选项路径、学生名换成 ID，得到语义树。前后端各自提供目录（QueryCatalog）。
 * - 未知键当普通文字并警告；解析错误（未知选项、非法日期、对无序属性用比较符）编译为“恒假”并报错，
 *   这样打错字不会悄悄放宽结果；
 * - 选项先精确匹配完整路径，再按末尾几段匹配（`完型填空` → `英语/完型填空`），多个匹配取并集并提示；
 * - `范围:`（in:）是全局修饰，作用于所有没写字段的自由词，多个取并集；
 * - 第一个正向的顶层学生条件同时作为列表的“按学生查看”上下文。
 */
import type { AttemptFilter, PropertyType, SearchField } from '../constants.js';
import { normalizeTagInput } from '../tagPath.js';
import { andQ, orQ, TRUE_Q, type Diagnostic, type PropTest, type Q, type QNode, type QValue } from './ast.js';
import { isValidDateTerm, type CmpOp, type DateSpec } from './dates.js';
import {
  ANY_WORDS,
  FALSE_WORDS,
  HAS_VALUES,
  IN_VALUES,
  NONE_WORDS,
  PROP_PREFIXES,
  reservedKey,
  STATUS_VALUES,
  STUDENT_STATES,
  TEXT_KEY_FIELD,
  TRUE_WORDS,
  type ReservedKey,
  type TextKey,
} from './keys.js';
import { nameKey, normText } from './normalize.js';
import { parseQuery } from './parse.js';

export interface CatalogOption {
  id: string;
  parentId: string | null;
  /** 完整路径，段之间用 / 分隔（选项名里的 / 已写成全角） */
  path: string;
}

export interface CatalogProperty {
  id: string;
  name: string;
  type: PropertyType;
  nested: boolean;
  appliesProblem: boolean;
  appliesMaterial: boolean;
  archived?: boolean;
  /** 按选项树的深度优先顺序 */
  options: CatalogOption[];
}

export interface QueryCatalog {
  properties: readonly CatalogProperty[];
  students: readonly { id: string; name: string }[];
}

export type Scope = 'problem' | 'material';

export interface ResolveResult {
  q: Q;
  diagnostics: Diagnostic[];
  /** 列表的“按学生查看”上下文 */
  studentId: string | null;
  /** 有正向的自由词（决定是否按相关度排序、是否生成片段） */
  hasFreeText: boolean;
}

const pathSegs = (p: string) => p.split('/').map(nameKey).filter(Boolean);

/** 在属性里按路径找选项：精确匹配完整路径，否则按末尾几段匹配。 */
export function matchOptions(def: CatalogProperty, value: string): CatalogOption[] {
  const want = pathSegs(value);
  if (want.length === 0) return [];
  const key = want.join('/');
  const exact = def.options.filter((o) => pathSegs(o.path).join('/') === key);
  if (exact.length) return exact;
  return def.options.filter((o) => {
    const segs = pathSegs(o.path);
    return segs.length > want.length && segs.slice(-want.length).join('/') === key;
  });
}

/** 按名称找属性（不含已归档的）；`属性.名称` / `prop.名称` 前缀已去掉。 */
export function findPropertyByName(catalog: QueryCatalog, name: string): CatalogProperty | undefined {
  const k = nameKey(name);
  return catalog.properties.find((d) => !d.archived && nameKey(d.name) === k);
}

/** 字段键的含义：保留键、属性，或未知 */
export type KeyMeaning = { kind: 'reserved'; key: ReservedKey } | { kind: 'prop'; def: CatalogProperty } | { kind: 'unknown'; prefixed: boolean; name: string };

export function keyMeaning(catalog: QueryCatalog, rawKey: string, hash = false): KeyMeaning {
  if (hash) return { kind: 'reserved', key: 'tag' };
  const nk = nameKey(rawKey);
  for (const p of PROP_PREFIXES) {
    if (nk.startsWith(p)) {
      const name = rawKey.trim().slice(p.length);
      const def = findPropertyByName(catalog, name);
      return def ? { kind: 'prop', def } : { kind: 'unknown', prefixed: true, name };
    }
  }
  const rk = reservedKey(rawKey);
  if (rk) return { kind: 'reserved', key: rk };
  const def = findPropertyByName(catalog, rawKey);
  return def ? { kind: 'prop', def } : { kind: 'unknown', prefixed: false, name: rawKey };
}

type FieldNode = Extract<QNode, { type: 'field' }>;

export function resolveQuery(src: string, ast: QNode | null, catalog: QueryCatalog, scope: Scope): ResolveResult {
  const diagnostics: Diagnostic[] = [];
  let studentId: string | null = null;
  let hasFreeText = false;
  const err = (from: number, to: number, message: string, suggestions?: string[]): Q => {
    diagnostics.push({ severity: 'error', from, to, message, ...(suggestions ? { suggestions } : {}) });
    return { k: 'false', reason: message };
  };
  const warn = (from: number, to: number, message: string) => diagnostics.push({ severity: 'warning', from, to, message });

  // 1. 全局的 范围:（in:）
  const inFields = new Set<SearchField>();
  const collectIn = (n: QNode, neg: boolean) => {
    if (n.type === 'and' || n.type === 'or') n.items.forEach((i) => collectIn(i, neg));
    else if (n.type === 'not') collectIn(n.item, !neg);
    else if (n.type === 'field' && !n.hash && reservedKey(n.key) === 'in') {
      if (neg) {
        warn(n.from, n.to, '“范围”不能取反，已忽略');
        return;
      }
      for (const v of n.values) {
        const f = IN_VALUES[nameKey(v.text)];
        if (f) inFields.add(f);
        else warn(v.from, v.to, `“${v.text}”不是可用的范围（标题 正文 笔记 答案 解析 来源 标签 属性）`);
      }
    }
  };
  if (ast) collectIn(ast, false);
  const scopeFields = inFields.size ? [...inFields] : undefined;

  const textQ = (value: string, phrase: boolean, fields: SearchField[] | undefined, neg: boolean, via?: 'in'): Q => {
    const v = normText(value);
    if (!v) return TRUE_Q;
    if (!neg) hasFreeText = true;
    return { k: 'text', value: v, phrase: phrase || v.includes(' '), ...(fields ? { fields } : {}), ...(via ? { via } : {}) };
  };

  const isWord = (v: QValue, words: Set<string>) => !v.quoted && words.has(nameKey(v.text));

  const dateSpecs = (n: FieldNode, what: string): DateSpec[] | Q => {
    const check = (v: QValue) => (isValidDateTerm(nameKey(v.text)) ? null : err(v.from, v.to, `无法识别的日期“${v.text}”（例如 2026-09、>=2026-09-01、本周、7天）`));
    if (n.range) {
      for (const v of [n.range.lo, n.range.hi]) if (v) {
        const e = check(v);
        if (e) return e;
      }
      return [{ kind: 'range', lo: n.range.lo ? nameKey(n.range.lo.text) : null, hi: n.range.hi ? nameKey(n.range.hi.text) : null }];
    }
    const out: DateSpec[] = [];
    for (const v of n.values) {
      const e = check(v);
      if (e) return e;
      out.push({ kind: 'cmp', op: n.op ?? '=', v: nameKey(v.text) });
    }
    if (n.op && out.length > 1) return err(n.from, n.to, `${what}的比较只能写一个值`);
    return out;
  };

  const resolveProp = (n: FieldNode, def: CatalogProperty): Q => {
    const applies = scope === 'problem' ? def.appliesProblem : def.appliesMaterial;
    if (!applies) return err(n.keyFrom, n.keyTo, `属性“${def.name}”不适用于${scope === 'problem' ? '题目' : '资料'}`);
    const prop = (test: PropTest): Q => ({ k: 'prop', propertyId: def.id, test });
    const special = (v: QValue): Q | null => (isWord(v, NONE_WORDS) ? prop({ t: 'none' }) : isWord(v, ANY_WORDS) ? prop({ t: 'any' }) : null);
    switch (def.type) {
      case 'select':
      case 'multiselect': {
        if (n.op || n.range) {
          if (def.type !== 'select' || def.nested) return err(n.from, n.to, `只有不分层的单选属性可以比较大小（“${def.name}”不行）`);
          const idx = (v: QValue): number | Q => {
            const m = matchOptions(def, v.text);
            if (m.length !== 1) return err(v.from, v.to, `“${def.name}”中没有选项“${v.text}”`, def.options.map((o) => o.path));
            return def.options.indexOf(m[0]!);
          };
          let lo = 0;
          let hi = def.options.length - 1;
          if (n.range) {
            if (n.range.lo) {
              const i = idx(n.range.lo);
              if (typeof i !== 'number') return i;
              lo = i;
            }
            if (n.range.hi) {
              const i = idx(n.range.hi);
              if (typeof i !== 'number') return i;
              hi = i;
            }
          } else {
            const i = idx(n.values[0]!);
            if (typeof i !== 'number') return i;
            const op = n.op!;
            if (op === '=') lo = hi = i;
            else if (op === '>=') lo = i;
            else if (op === '>') lo = i + 1;
            else if (op === '<=') hi = i;
            else hi = i - 1;
          }
          const ids = def.options.slice(Math.max(lo, 0), Math.max(hi + 1, 0)).map((o) => o.id);
          return ids.length ? prop({ t: 'options', optionIds: ids }) : { k: 'false', reason: '没有符合的选项' };
        }
        const parts: Q[] = [];
        const ids: string[] = [];
        for (const v of n.values) {
          const s = special(v);
          if (s) {
            parts.push(s);
            continue;
          }
          const m = matchOptions(def, v.text);
          if (m.length === 0) {
            parts.push(err(v.from, v.to, `“${def.name}”中没有选项“${v.text}”`, def.options.filter((o) => nameKey(o.path).includes(nameKey(v.text))).map((o) => o.path).slice(0, 8)));
            continue;
          }
          if (m.length > 1) warn(v.from, v.to, `“${v.text}”匹配多个选项（${m.map((o) => o.path).join('、')}），已取并集；写完整路径可以只选一个`);
          ids.push(...m.map((o) => o.id));
        }
        if (ids.length) parts.unshift(prop({ t: 'options', optionIds: [...new Set(ids)] }));
        return orQ(parts);
      }
      case 'checkbox': {
        if (n.op || n.range) return err(n.from, n.to, `勾选属性“${def.name}”只能写 是 / 否`);
        const parts = n.values.map((v): Q => {
          if (isWord(v, TRUE_WORDS) || isWord(v, ANY_WORDS)) return prop({ t: 'checked', value: true });
          if (isWord(v, FALSE_WORDS) || isWord(v, NONE_WORDS)) return prop({ t: 'checked', value: false });
          return err(v.from, v.to, `勾选属性“${def.name}”只能写 是 / 否`);
        });
        return orQ(parts);
      }
      case 'number': {
        const num = (v: QValue): number | Q => {
          const x = Number(v.text.normalize('NFKC').trim());
          return v.text.trim() && Number.isFinite(x) ? x : err(v.from, v.to, `“${v.text}”不是数字`);
        };
        if (n.range) {
          const lo = n.range.lo ? num(n.range.lo) : null;
          const hi = n.range.hi ? num(n.range.hi) : null;
          if (typeof lo === 'object' && lo !== null) return lo;
          if (typeof hi === 'object' && hi !== null) return hi;
          return prop({ t: 'numberRange', lo, hi });
        }
        return orQ(
          n.values.map((v) => {
            const s = special(v);
            if (s) return s;
            const x = num(v);
            return typeof x === 'number' ? prop({ t: 'number', op: n.op ?? '=', value: x }) : x;
          }),
        );
      }
      case 'date': {
        const specials = n.range || n.op ? [] : n.values.map(special);
        if (specials.length && specials.every(Boolean)) return orQ(specials as Q[]);
        const specs = dateSpecs(n, `“${def.name}”`);
        if (!Array.isArray(specs)) return specs;
        return orQ(specs.map((spec) => prop({ t: 'date', spec })));
      }
      case 'text': {
        if (n.op || n.range) return err(n.from, n.to, `文本属性“${def.name}”不支持比较`);
        return orQ(n.values.map((v) => special(v) ?? prop({ t: 'text', value: normText(v.text) })));
      }
    }
  };

  const resolveStudent = (v: QValue): { id: string; state: AttemptFilter } | Q => {
    let raw = v.text.trim();
    let state: AttemptFilter = 'done';
    const slash = raw.lastIndexOf('/');
    if (slash > 0) {
      const s = STUDENT_STATES[nameKey(raw.slice(slash + 1))];
      if (!s) return err(v.from, v.to, `无法识别的作答状态“${raw.slice(slash + 1)}”（做过 / 没做 / 错过 / 最近错）`);
      state = s;
      raw = raw.slice(0, slash);
    }
    let prefix = '';
    const hash = raw.lastIndexOf('#');
    if (hash > 0 && /^[0-9a-f]{4,}$/i.test(raw.slice(hash + 1))) {
      prefix = raw.slice(hash + 1).toLowerCase();
      raw = raw.slice(0, hash);
    }
    const k = nameKey(raw);
    const cands = catalog.students.filter((s) => nameKey(s.name) === k && s.id.startsWith(prefix));
    if (cands.length === 0) return err(v.from, v.to, `没有名为“${raw}”的学生`);
    if (cands.length > 1) return err(v.from, v.to, `有 ${cands.length} 个同名学生，请写成“名字#ID前4位”`, cands.map((s) => `${s.name}#${s.id.slice(0, 4)}`));
    return { id: cands[0]!.id, state };
  };

  const resolveField = (n: FieldNode, neg: boolean, top: boolean): Q => {
    const meaning = keyMeaning(catalog, n.key, n.hash);
    if (meaning.kind === 'unknown') {
      if (meaning.prefixed) return err(n.keyFrom, n.keyTo, `没有名为“${meaning.name}”的属性`, catalog.properties.filter((d) => !d.archived).map((d) => d.name));
      warn(n.keyFrom, n.keyTo, `“${n.key}”不是已知的字段或属性，按普通文字查找`);
      return textQ(src.slice(n.from, n.to), false, scopeFields, neg, scopeFields ? 'in' : undefined);
    }
    if (meaning.kind === 'prop') return resolveProp(n, meaning.def);
    const key = meaning.key;
    const noCompare = () => (n.op || n.range ? err(n.from, n.to, `“${n.key}”不支持比较`) : null);
    switch (key) {
      case 'title':
      case 'content':
      case 'note':
      case 'answer':
      case 'solution':
      case 'source': {
        if (scope === 'material' && (key === 'note' || key === 'answer' || key === 'solution')) return err(n.keyFrom, n.keyTo, '资料没有笔记、答案与解析');
        const e = noCompare();
        if (e) return e;
        return orQ(n.values.map((v) => textQ(v.text, v.quoted, [TEXT_KEY_FIELD[key as TextKey]], neg)));
      }
      case 'tag': {
        const e = noCompare();
        if (e) return e;
        const paths: string[] = [];
        const parts: Q[] = [];
        for (const v of n.values) {
          if (isWord(v, NONE_WORDS)) parts.push({ k: 'untagged' });
          else {
            const p = normalizeTagInput(v.text);
            if (p) paths.push(p);
          }
        }
        if (paths.length) parts.unshift({ k: 'tag', paths: [...new Set(paths)] });
        return orQ(parts);
      }
      case 'subject':
      case 'stage': {
        const e = noCompare();
        if (e) return e;
        return { k: 'dict', field: key, values: [...new Set(n.values.map((v) => (isWord(v, NONE_WORDS) ? null : v.text.trim())))] };
      }
      case 'status': {
        if (scope === 'problem') return err(n.keyFrom, n.keyTo, '题目没有整理状态');
        const e = noCompare();
        if (e) return e;
        return orQ(n.values.map((v): Q => {
          const s = STATUS_VALUES[nameKey(v.text)];
          return s ? { k: 'status', value: s } : err(v.from, v.to, `无法识别的状态“${v.text}”（待整理 / 已整理）`);
        }));
      }
      case 'student': {
        if (scope === 'material') return err(n.keyFrom, n.keyTo, '资料没有作答记录');
        const e = noCompare();
        if (e) return e;
        const parts = n.values.map((v): Q => {
          const r = resolveStudent(v);
          if ('k' in r) return r;
          if (top && !neg && studentId === null) studentId = r.id;
          return { k: 'student', studentId: r.id, state: r.state };
        });
        return orQ(parts);
      }
      case 'created':
      case 'updated': {
        const specs = dateSpecs(n, key === 'created' ? '“创建”' : '“修改”');
        if (!Array.isArray(specs)) return specs;
        return orQ(specs.map((spec): Q => ({ k: 'date', field: key, spec })));
      }
      case 'has': {
        const e = noCompare();
        if (e) return e;
        return orQ(n.values.map((v): Q => {
          const w = HAS_VALUES[nameKey(v.text)];
          if (w) {
            if (scope === 'material' && (w === 'answer' || w === 'solution' || w === 'note')) return err(v.from, v.to, '资料没有笔记、答案与解析');
            return { k: 'has', what: w };
          }
          const def = findPropertyByName(catalog, v.text);
          if (def) return { k: 'prop', propertyId: def.id, test: { t: 'any' } };
          return err(v.from, v.to, `无法识别“有:${v.text}”（答案 解析 笔记 图片 标签 来源 标题，或属性名）`);
        }));
      }
      case 'in':
        return TRUE_Q;
    }
  };

  const conv = (n: QNode, neg: boolean, top: boolean): Q => {
    switch (n.type) {
      case 'and':
        return andQ(n.items.map((i) => conv(i, neg, top)));
      case 'or':
        return orQ(n.items.map((i) => conv(i, neg, false)));
      case 'not': {
        const inner = conv(n.item, !neg, false);
        if (inner.k === 'true') return TRUE_Q;
        return { k: 'not', item: inner };
      }
      case 'text':
        return textQ(n.value, n.phrase, scopeFields, neg, scopeFields ? 'in' : undefined);
      case 'field':
        return resolveField(n, neg, top);
    }
  };

  const q = ast ? conv(ast, false, true) : TRUE_Q;
  return { q, diagnostics, studentId, hasFreeText };
}

/** 解析 + 名称解析 */
export function compileText(src: string, catalog: QueryCatalog, scope: Scope): ResolveResult & { ast: QNode | null } {
  const p = parseQuery(src);
  const r = resolveQuery(src.slice(0, 1000), p.ast, catalog, scope);
  return { ...r, ast: p.ast, diagnostics: [...p.diagnostics, ...r.diagnostics].sort((a, b) => a.from - b.from) };
}

export type { CmpOp };
