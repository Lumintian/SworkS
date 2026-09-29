/**
 * 列表筛选参数的唯一编解码：前端地址栏与服务端列表接口共用，避免两边各拼一套。
 *
 * 参数：
 * - `q` 查询文本（查询语言，见 docs/search-syntax.md；最长 1000 字）。所有条件优先写在这里；
 *   下面这些旧参数仍然有效（旧书签、旧链接），服务端把它们转成语义条件（filtersToAst）后与 q 取“且”
 * - `subject`、`stage` 精确匹配，值为 NONE_VALUE 时表示“未设置”
 * - `tag=<路径>` 可重复：每个路径展开为整棵子树（子树内为“或”），多个 tag 之间为“且”
 * - `untagged=1` 只看没有标签的对象
 * - `tags=<ID,…>` 旧参数：按标签 ID 精确匹配，多个为“且”
 * - `prop=<属性ID>:<值,…>` 可重复：值为选项 ID（含子树）、NONE_VALUE（未设置）或 TRUE_VALUE（勾选）；
 *   同一属性内为“或”，不同属性之间为“且”
 * - `student=<学生ID>` 列表项附带该学生的作答摘要；`attempt` none | done | wrong-ever | wrong-last 按作答状态筛选
 * - `sort` created | updated | relevance | prop:<属性ID>（按单选属性的选项顺序；分层时按选项树的深度优先顺序）；
 *   省略（auto）时：有正向自由词按相关度，否则按创建时间
 * - `status` 资料整理状态（页面级条件，不写入地址栏）
 */
import { isUuid } from './assetRef.js';
import { ATTEMPT_FILTERS, MATERIAL_STATUSES, type AttemptFilter, type MaterialStatus } from './constants.js';
import { andQ, orQ, TRUE_Q, type Q } from './query/ast.js';
import { normalizeTagInput } from './tagPath.js';

/** “未设置”这一特殊筛选值。 */
export const NONE_VALUE = '__none__';
/** 勾选属性“已勾选”的筛选值。 */
export const TRUE_VALUE = '__true__';

export type ListSort = 'auto' | 'created' | 'updated' | 'relevance' | `prop:${string}`;

/** 查询文本的长度上限 */
export const MAX_QUERY_LENGTH = 1000;

export interface PropFilter {
  propertyId: string;
  values: string[];
}

export interface ListFilters {
  q: string;
  subject: string;
  stage: string;
  tagPaths: string[];
  tagIds: string[];
  untagged: boolean;
  props: PropFilter[];
  student: string;
  attempt: AttemptFilter | '';
  sort: ListSort;
  status?: MaterialStatus | undefined;
}

export const EMPTY_FILTERS: ListFilters = {
  q: '',
  subject: '',
  stage: '',
  tagPaths: [],
  tagIds: [],
  untagged: false,
  props: [],
  student: '',
  attempt: '',
  sort: 'auto',
};

function parseProps(raw: string[]): PropFilter[] {
  const byProp = new Map<string, Set<string>>();
  for (const r of raw.slice(0, 20)) {
    const i = r.indexOf(':');
    if (i < 0) continue;
    const pid = r.slice(0, i).toLowerCase();
    if (!isUuid(pid)) continue;
    const vals = r
      .slice(i + 1)
      .split(',')
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v === NONE_VALUE || v === TRUE_VALUE || isUuid(v));
    if (vals.length === 0) continue;
    const set = byProp.get(pid) ?? new Set();
    for (const v of vals.slice(0, 50)) set.add(v);
    byProp.set(pid, set);
  }
  return [...byProp].map(([propertyId, set]) => ({ propertyId, values: [...set] }));
}

function parseSort(raw: string | null): ListSort {
  if (raw === 'updated' || raw === 'created' || raw === 'relevance') return raw;
  if (raw?.startsWith('prop:') && isUuid(raw.slice(5))) return `prop:${raw.slice(5).toLowerCase()}`;
  return 'auto';
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function parseListFilters(p: URLSearchParams): ListFilters {
  const status = p.get('status');
  return {
    q: (p.get('q') ?? '').slice(0, MAX_QUERY_LENGTH),
    subject: (p.get('subject') ?? '').slice(0, 50),
    stage: (p.get('stage') ?? '').slice(0, 50),
    tagPaths: uniq(
      p
        .getAll('tag')
        .map((t) => normalizeTagInput(t.slice(0, 200)))
        .filter(Boolean),
    ).slice(0, 20),
    tagIds: uniq(
      (p.get('tags') ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(isUuid),
    ).slice(0, 50),
    untagged: p.get('untagged') === '1',
    props: parseProps(p.getAll('prop')),
    student: isUuid(p.get('student') ?? '') ? p.get('student')!.toLowerCase() : '',
    attempt: isUuid(p.get('student') ?? '') && ATTEMPT_FILTERS.includes(p.get('attempt') as AttemptFilter) ? (p.get('attempt') as AttemptFilter) : '',
    sort: parseSort(p.get('sort')),
    status: MATERIAL_STATUSES.includes(status as MaterialStatus) ? (status as MaterialStatus) : undefined,
  };
}

/** 编码为查询参数；默认值不写出，保持地址简洁。 */
export function listFiltersToParams(f: Partial<ListFilters>): URLSearchParams {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.subject) p.set('subject', f.subject);
  if (f.stage) p.set('stage', f.stage);
  for (const t of f.tagPaths ?? []) p.append('tag', t);
  if (f.tagIds?.length) p.set('tags', f.tagIds.join(','));
  if (f.untagged) p.set('untagged', '1');
  for (const pf of f.props ?? []) if (pf.values.length) p.append('prop', `${pf.propertyId}:${pf.values.join(',')}`);
  if (f.student) p.set('student', f.student);
  if (f.student && f.attempt) p.set('attempt', f.attempt);
  if (f.sort && f.sort !== 'auto') p.set('sort', f.sort);
  if (f.status) p.set('status', f.status);
  return p;
}

/** 除排序与页面级状态外，是否设置了任何筛选条件。 */
export function hasActiveFilters(f: ListFilters): boolean {
  return Boolean(f.q || f.subject || f.stage || f.tagPaths.length || f.tagIds.length || f.untagged || f.props.length || f.attempt);
}

/**
 * 旧的筛选参数转成语义条件（与查询文本取“且”）。tagIds（按标签 ID 精确匹配）由服务端单独处理。
 * 学生参数只在同时给了 attempt 时才是筛选条件；单独的 student 只是“按学生查看”的上下文。
 */
export function filtersToAst(f: Partial<ListFilters>): Q {
  const parts: Q[] = [];
  const dict = (field: 'subject' | 'stage', v: string | undefined) => {
    if (v) parts.push({ k: 'dict', field, values: [v === NONE_VALUE ? null : v] });
  };
  dict('subject', f.subject);
  dict('stage', f.stage);
  for (const path of f.tagPaths ?? []) parts.push({ k: 'tag', paths: [path] });
  if (f.untagged) parts.push({ k: 'untagged' });
  for (const pf of f.props ?? []) {
    const ors: Q[] = [];
    const optionIds = pf.values.filter((v) => v !== NONE_VALUE && v !== TRUE_VALUE);
    if (optionIds.length) ors.push({ k: 'prop', propertyId: pf.propertyId, test: { t: 'options', optionIds } });
    if (pf.values.includes(TRUE_VALUE)) ors.push({ k: 'prop', propertyId: pf.propertyId, test: { t: 'checked', value: true } });
    if (pf.values.includes(NONE_VALUE)) ors.push({ k: 'prop', propertyId: pf.propertyId, test: { t: 'none' } });
    parts.push(orQ(ors));
  }
  if (f.student && f.attempt) parts.push({ k: 'student', studentId: f.student, state: f.attempt });
  return parts.length ? andQ(parts) : TRUE_Q;
}
