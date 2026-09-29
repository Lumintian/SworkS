/**
 * 条件面板：查询文本的另一种编辑方式，两边同步——
 * 文本里每个顶层条件一行 [字段][是/不是][比较][值][×]；OR、括号等复杂条件显示为只读的“自定义表达式”。
 * 面板里的修改只改写对应条件在文本中的那一段，其余手打的文字保持原样。
 */
import { Plus, SlidersHorizontal, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { PropertyDefDTO } from '@shared/api';
import { SEARCH_FIELDS, type SearchField } from '@shared/constants';
import {
  appendCondition,
  conditionRows,
  FIELD_LABEL,
  formatValue,
  HAS_LABEL,
  IN_VALUES,
  KEY_LABEL,
  nameKey,
  parseQuery,
  propertyKey,
  removeRange,
  replaceRange,
  STUDENT_STATE_LABEL,
  STUDENT_STATES,
  type ConditionRow,
  type ReservedKey,
  type Scope,
} from '@shared/query';
import { errorMessage, sendJSON } from '../../lib/api';
import { newId } from '../../lib/format';
import { invalidateWrites } from '../../lib/queryClient';
import type { QueryContext } from '../../lib/queryText';
import { TagPicker } from '../list/TagPicker';
import { Popover, PopoverContent, PopoverTrigger } from '../Menu';
import { OptionPicker } from '../props/OptionPicker';
import { useToast } from '../ui';

type Kind = 'text' | 'textField' | 'tag' | 'dict' | 'options' | 'checkbox' | 'number' | 'date' | 'textProp' | 'has' | 'status' | 'student';
type Op = '=' | '>=' | '<=' | '>' | '<' | '..';

interface FieldDesc {
  id: string;
  label: string;
  kind: Kind;
  /** 条件文本里的键（自由词为空） */
  key: string;
  def?: PropertyDefDTO;
  dict?: 'subject' | 'stage';
  comparable?: boolean;
}

interface Draft {
  field: FieldDesc;
  negated: boolean;
  op: Op;
  values: string[];
}

const TEXT_KEYS: ReservedKey[] = ['title', 'content', 'note', 'answer', 'solution', 'source'];
/** 需要手动输入的值：填好后点“加上这个条件”；其余（选择类）选好即生效 */
const TYPED_KINDS: Kind[] = ['text', 'textField', 'date', 'number', 'textProp'];

function fieldList(ctx: QueryContext, scope: Scope): FieldDesc[] {
  const out: FieldDesc[] = [{ id: 'text', label: '文字', kind: 'text', key: '' }];
  out.push({ id: 'tag', label: '标签', kind: 'tag', key: '标签' });
  for (const d of ctx.catalog.properties) {
    if (!(scope === 'problem' ? d.appliesProblem : d.appliesMaterial)) continue;
    const kind: Kind = d.type === 'select' || d.type === 'multiselect' ? 'options' : d.type === 'checkbox' ? 'checkbox' : d.type === 'number' ? 'number' : d.type === 'date' ? 'date' : 'textProp';
    out.push({ id: `prop:${d.id}`, label: d.name, kind, key: propertyKey(d), def: d, comparable: kind === 'number' || kind === 'date' || (d.type === 'select' && !d.nested) });
  }
  out.push({ id: 'subject', label: '学科', kind: 'dict', key: '学科', dict: 'subject' }, { id: 'stage', label: '学段', kind: 'dict', key: '学段', dict: 'stage' });
  for (const k of TEXT_KEYS) {
    if (scope === 'material' && (k === 'note' || k === 'answer' || k === 'solution')) continue;
    out.push({ id: k, label: `${KEY_LABEL[k]}中包含`, kind: 'textField', key: KEY_LABEL[k] });
  }
  out.push({ id: 'created', label: '添加日期', kind: 'date', key: '创建', comparable: true }, { id: 'updated', label: '修改日期', kind: 'date', key: '修改', comparable: true });
  out.push({ id: 'has', label: '有', kind: 'has', key: '有' });
  if (scope === 'problem') out.push({ id: 'student', label: '学生作答', kind: 'student', key: '学生' });
  else out.push({ id: 'status', label: '整理状态', kind: 'status', key: '状态' });
  return out;
}

function draftOf(row: ConditionRow, fields: FieldDesc[]): Draft | null {
  if (row.kind !== 'field' || !row.node || !row.meaning) return null;
  const m = row.meaning;
  const field = m.kind === 'prop' ? fields.find((f) => f.def?.id === m.def.id) : m.kind === 'reserved' ? fields.find((f) => f.id === m.key) : undefined;
  if (!field) return null;
  const n = row.node;
  if (n.range) return { field, negated: row.negated, op: '..', values: [n.range.lo?.text ?? '', n.range.hi?.text ?? ''] };
  return { field, negated: row.negated, op: n.op ?? '=', values: n.values.map((v) => v.text) };
}

function condText(d: Draft): string | null {
  const vals = d.values.map((v) => v.trim()).filter(Boolean);
  const neg = d.negated ? '-' : '';
  if (d.field.kind === 'text') return vals.length ? `${neg}${formatValue(vals.join(' '))}` : null;
  if (d.op === '..') {
    const [lo = '', hi = ''] = d.values.map((v) => v.trim());
    if (!lo && !hi) return null;
    return `${neg}${d.field.key}:${lo}..${hi}`;
  }
  if (!vals.length) return null;
  if (d.field.kind === 'tag' && vals.length === 1 && !d.negated && !/[\s"“”()（）:：,，|｜#]/u.test(vals[0]!)) return `#${vals[0]}`;
  const op = d.op === '=' ? '' : d.op;
  return `${neg}${d.field.key}:${op}${op ? vals[0]! : vals.map(formatValue).join(',')}`;
}

function Chip({ children, onRemove }: { children: ReactNode; onRemove: () => void }) {
  return (
    <span className="chip chip-stone gap-1 py-0.5 pl-2 pr-1 text-xs">
      {children}
      <button type="button" className="rounded-full p-0.5 opacity-70 hover:opacity-100" aria-label="移除" onClick={onRemove}>
        <X size={11} />
      </button>
    </span>
  );
}

/** 输入框：live 时每次输入都上报（新条件的草稿），否则回车或失去焦点时才提交（避免每个字都改写查询） */
function ValueInput({ value, placeholder, live, onCommit }: { value: string; placeholder: string; live: boolean; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className="input w-auto min-w-[8rem] max-w-[16rem] flex-1 py-1 text-sm"
      value={v}
      placeholder={placeholder}
      aria-label="条件的值"
      onChange={(e) => {
        setV(e.target.value);
        if (live) onCommit(e.target.value);
      }}
      onBlur={() => !live && v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !live) {
          e.preventDefault();
          onCommit(v);
        }
      }}
    />
  );
}

function ValueEditor({ draft, ctx, live, onChange }: { draft: Draft; ctx: QueryContext; live: boolean; onChange: (values: string[]) => void }) {
  const { field, values } = draft;
  const [open, setOpen] = useState(false);
  const input = (i: number, placeholder: string) => (
    <ValueInput
      value={values[i] ?? ''}
      placeholder={placeholder}
      live={live}
      onCommit={(x) => {
        const next = [...values];
        next[i] = x;
        onChange(next);
      }}
    />
  );
  if (draft.op === '..') {
    return (
      <span className="flex items-center gap-1">
        {input(0, '从')}
        <span className="text-ink-faint">至</span>
        {input(1, '到')}
      </span>
    );
  }
  const select = (options: string[], placeholder = '请选择') => (
    <select className="select w-auto py-1 text-sm" aria-label="条件的值" value={values[0] ?? ''} onChange={(e) => onChange(e.target.value ? [e.target.value] : [])}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
  switch (field.kind) {
    case 'tag':
    case 'options': {
      if (field.kind === 'options' && draft.op !== '=') return select(field.def!.options.map((o) => o.path));
      return (
        <span className="flex flex-wrap items-center gap-1">
          {values.map((v, i) => (
            <Chip key={`${v}-${i}`} onRemove={() => onChange(values.filter((_, j) => j !== i))}>
              {v}
            </Chip>
          ))}
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`选择${field.label}`}>
                <Plus size={13} /> {values.length ? '或…' : '选择…'}
              </button>
            </PopoverTrigger>
            <PopoverContent>
              {field.kind === 'tag' ? (
                <TagPicker
                  tags={ctx.catalog.tags.map((t) => t.name)}
                  placeholder="选择标签…"
                  onPick={(name) => {
                    setOpen(false);
                    onChange([...values, name]);
                  }}
                />
              ) : (
                <OptionPicker
                  def={field.def!}
                  selected={field.def!.options.filter((o) => values.some((v) => nameKey(v) === nameKey(o.path))).map((o) => o.id)}
                  allowCreate={false}
                  onPick={(id) => {
                    setOpen(false);
                    const path = field.def!.options.find((o) => o.id === id)?.path;
                    if (path && !values.includes(path)) onChange([...values, path]);
                  }}
                />
              )}
            </PopoverContent>
          </Popover>
          {field.kind === 'options' && !values.includes('无') ? (
            <button type="button" className="btn btn-ghost btn-sm text-xs" onClick={() => onChange([...values, '无'])}>
              未设置
            </button>
          ) : null}
        </span>
      );
    }
    case 'dict':
      return select([...(field.dict === 'subject' ? ctx.catalog.subjects : ctx.catalog.stages), '无']);
    case 'checkbox':
      return select(['是', '否']);
    case 'has':
      return select([...Object.values(HAS_LABEL), ...ctx.catalog.properties.map((d) => d.name)]);
    case 'status':
      return select(['待整理', '已整理']);
    case 'student': {
      const raw = values[0] ?? '';
      const slash = raw.lastIndexOf('/');
      const name = slash > 0 ? raw.slice(0, slash) : raw;
      const state = slash > 0 ? raw.slice(slash + 1) : '做过';
      const set = (n: string, s: string) => onChange(n ? [s === '做过' ? n : `${n}/${s}`] : []);
      return (
        <span className="flex items-center gap-1">
          <select className="select w-auto py-1 text-sm" aria-label="学生" value={name} onChange={(e) => set(e.target.value, state)}>
            <option value="">选择学生</option>
            {ctx.students.map((s) => (
              <option key={s.id} value={ctx.students.filter((x) => x.name === s.name).length > 1 ? `${s.name}#${s.id.slice(0, 4)}` : s.name}>
                {s.name}
              </option>
            ))}
          </select>
          <select className="select w-auto py-1 text-sm" aria-label="作答状态" value={STUDENT_STATE_LABEL[STUDENT_STATES[state] ?? 'done']} onChange={(e) => set(name, e.target.value)}>
            {Object.values(STUDENT_STATE_LABEL).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </span>
      );
    }
    case 'date':
      return input(0, '2026-09、本周、7天…');
    case 'number':
      return input(0, '数字');
    default:
      return input(0, field.kind === 'text' ? '要找的文字' : '包含的文字');
  }
}

const OPS: { op: Op; label: string }[] = [
  { op: '=', label: '等于' },
  { op: '>=', label: '≥' },
  { op: '<=', label: '≤' },
  { op: '>', label: '>' },
  { op: '<', label: '<' },
  { op: '..', label: '区间' },
];

function ConditionEditor({
  draft,
  fields,
  ctx,
  live = false,
  onChange,
  onRemove,
}: {
  draft: Draft;
  fields: FieldDesc[];
  ctx: QueryContext;
  live?: boolean;
  onChange: (d: Draft) => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="condition-row">
      <select
        className="select w-auto py-1 text-sm"
        aria-label="字段"
        value={draft.field.id}
        onChange={(e) => onChange({ field: fields.find((f) => f.id === e.target.value)!, negated: draft.negated, op: '=', values: [] })}
      >
        {fields.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
      </select>
      <select className="select w-auto py-1 text-sm" aria-label="是否取反" value={draft.negated ? 'not' : 'is'} onChange={(e) => onChange({ ...draft, negated: e.target.value === 'not' })}>
        <option value="is">{draft.field.kind === 'text' || draft.field.kind === 'textField' ? '包含' : '是'}</option>
        <option value="not">{draft.field.kind === 'text' || draft.field.kind === 'textField' ? '不包含' : '不是'}</option>
      </select>
      {draft.field.comparable ? (
        <select className="select w-auto py-1 text-sm" aria-label="比较" value={draft.op} onChange={(e) => onChange({ ...draft, op: e.target.value as Op, values: [] })}>
          {OPS.map((o) => (
            <option key={o.op} value={o.op}>
              {o.label}
            </option>
          ))}
        </select>
      ) : null}
      <ValueEditor draft={draft} ctx={ctx} live={live} onChange={(values) => onChange({ ...draft, values })} />
      <button type="button" className="btn btn-ghost btn-sm btn-icon ml-auto" aria-label="删除这个条件" onClick={onRemove}>
        <X size={14} />
      </button>
    </div>
  );
}

const SYNTAX: [string, string][] = [
  ['函数 最值', '同时包含两个词'],
  ['函数 OR 数列', '包含其一（也可写 |）'],
  ['-向量', '排除'],
  ['"二次 函数"', '短语'],
  ['#方法/换元', '标签（含下级）'],
  ['题型:完型填空', '属性（可只写末级）'],
  ['难度:>=较难', '有序属性的比较'],
  ['学科:无', '未设置'],
  ['有:答案 / -有:解析', '有没有答案、解析'],
  ['创建:本周  修改:>=2026-09-01', '日期'],
  ['学生:小明/错过', '按学生的作答'],
  ['范围:标题,答案', '自由词只在这些地方找'],
];

export function ConditionPanel({
  text,
  onChange,
  ctx,
  scope,
  onEditInText,
}: {
  text: string;
  onChange: (text: string) => void;
  ctx: QueryContext;
  scope: Scope;
  onEditInText: (from: number, to: number) => void;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<Draft | null>(null);
  const [saveName, setSaveName] = useState('');
  const fields = useMemo(() => fieldList(ctx, scope), [ctx, scope]);
  const rows = useMemo(() => conditionRows(text, parseQuery(text).ast, ctx.qc, scope), [text, ctx.qc, scope]);
  const inRows = rows.filter((r) => r.kind === 'field' && r.meaning?.kind === 'reserved' && r.meaning.key === 'in');
  const inFields = new Set<SearchField>(inRows.flatMap((r) => r.node!.values.map((v) => IN_VALUES[nameKey(v.text)]).filter((f): f is SearchField => Boolean(f))));
  const count = rows.length - inRows.length;

  const setInFields = (next: Set<SearchField>) => {
    let t = text;
    for (const r of [...inRows].sort((a, b) => b.from - a.from)) t = removeRange(t, r.from, r.to);
    if (next.size) t = appendCondition(t, `范围:${SEARCH_FIELDS.filter((f) => next.has(f)).map((f) => FIELD_LABEL[f]).join(',')}`);
    onChange(t);
  };

  const saveSearch = async () => {
    try {
      await sendJSON('POST', '/api/saved-searches', { id: newId(), scope, name: saveName.trim(), text });
      invalidateWrites({ problems: [], materials: [] });
      toast(`已保存为常用检索“${saveName.trim()}”`, 'success');
      setSaveName('');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={`btn btn-sm ${count ? 'btn-sage' : 'btn-ghost'}`} aria-label="筛选条件面板" data-testid="condition-panel-toggle">
          <SlidersHorizontal size={14} /> 条件{count ? ` ${count}` : ''}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(40rem,92vw)]">
        <div className="max-h-[70vh] space-y-3 overflow-y-auto p-3 text-sm" data-testid="condition-panel">
          <div className="space-y-2">
            {rows.map((r, i) => {
              if (inRows.includes(r)) return null;
              const d = draftOf(r, fields);
              if (r.kind === 'text') {
                const node = text.slice(r.from, r.to);
                const plain = r.negated ? node.slice(1) : node;
                return (
                  <ConditionEditor
                    key={`row-${i}`}
                    draft={{ field: fields[0]!, negated: r.negated, op: '=', values: [plain.replace(/^["“](.*)["”]$/u, '$1')] }}
                    fields={fields}
                    ctx={ctx}
                    onChange={(nd) => onChange(replaceRange(text, r.from, r.to, condText(nd) ?? ''))}
                    onRemove={() => onChange(removeRange(text, r.from, r.to))}
                  />
                );
              }
              if (!d) {
                return (
                  <div key={`row-${i}`} className="flex items-center gap-2" data-testid="condition-row">
                    <span className="text-xs text-ink-faint">自定义表达式</span>
                    <code className="min-w-0 flex-1 truncate rounded bg-sunken px-2 py-1">{text.slice(r.from, r.to)}</code>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setOpen(false);
                        onEditInText(r.from, r.to);
                      }}
                    >
                      在文本中编辑
                    </button>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="删除这个条件" onClick={() => onChange(removeRange(text, r.from, r.to))}>
                      <X size={14} />
                    </button>
                  </div>
                );
              }
              return (
                <ConditionEditor
                  key={`row-${i}`}
                  draft={d}
                  fields={fields}
                  ctx={ctx}
                  onChange={(nd) => {
                    const c = condText(nd);
                    // 值还没填完时保留原条件，等填好再改写
                    if (c !== null) onChange(replaceRange(text, r.from, r.to, c));
                  }}
                  onRemove={() => onChange(removeRange(text, r.from, r.to))}
                />
              );
            })}
            {adding ? (
              <ConditionEditor
                draft={adding}
                fields={fields}
                ctx={ctx}
                live
                onChange={(nd) => {
                  const c = condText(nd);
                  if (c !== null && !TYPED_KINDS.includes(nd.field.kind)) {
                    onChange(appendCondition(text, c));
                    setAdding(null);
                  } else setAdding(nd);
                }}
                onRemove={() => setAdding(null)}
              />
            ) : null}
            {adding && condText(adding) && TYPED_KINDS.includes(adding.field.kind) ? (
              <button
                type="button"
                className="btn btn-sage btn-sm"
                onClick={() => {
                  onChange(appendCondition(text, condText(adding)!));
                  setAdding(null);
                }}
              >
                加上这个条件
              </button>
            ) : null}
            {!adding ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding({ field: fields[1]!, negated: false, op: '=', values: [] })}>
                <Plus size={14} /> 添加条件
              </button>
            ) : null}
          </div>

          <fieldset className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2">
            <legend className="float-left mr-2 text-xs text-ink-faint">自由词的查找范围</legend>
            {SEARCH_FIELDS.filter((f) => scope === 'problem' || (f !== 'note' && f !== 'answer' && f !== 'solution')).map((f) => (
              <label key={f} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  className="accent-[var(--color-sage-deep)]"
                  checked={inFields.has(f)}
                  onChange={(e) => {
                    const next = new Set(inFields);
                    if (e.target.checked) next.add(f);
                    else next.delete(f);
                    setInFields(next);
                  }}
                />
                {FIELD_LABEL[f]}
              </label>
            ))}
            <span className="text-xs text-ink-faint">{inFields.size ? '' : '（不选即全部）'}</span>
          </fieldset>

          <form
            className="flex items-center gap-2 border-t border-line pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (saveName.trim() && text.trim()) void saveSearch();
            }}
          >
            <input className="input py-1 text-sm" value={saveName} maxLength={60} placeholder="给当前条件起个名字" aria-label="常用检索名称" onChange={(e) => setSaveName(e.target.value)} />
            <button type="submit" className="btn btn-sm" disabled={!saveName.trim() || !text.trim()}>
              保存为常用检索
            </button>
          </form>

          <details className="border-t border-line pt-2">
            <summary className="cursor-pointer text-xs text-ink-soft">语法速查</summary>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {SYNTAX.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt>
                    <code className="rounded bg-sunken px-1">{k}</code>
                  </dt>
                  <dd className="text-ink-soft">{v}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      </PopoverContent>
    </Popover>
  );
}
