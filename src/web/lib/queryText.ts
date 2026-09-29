/**
 * 页面上的查询文本：把缓存的目录转成查询语言的目录、导航节点对应的条件文本、旧地址参数转成查询文本。
 * 所有条件都只写在搜索框（地址栏的 q）里，导航点击也是改写这段文本（GitHub 式）。
 */
import { useMemo } from 'react';
import type { PropertyDefDTO, StudentDTO } from '@shared/api';
import { hasActiveFilters, NONE_VALUE, TRUE_VALUE, filtersToAst, type ListFilters } from '@shared/listFilters';
import { andQ, fieldText, formatValue, propertyKey, serializeQuery, type Q, type QueryCatalog } from '@shared/query';
import { useStudents } from './queries';
import { useCatalog, type Catalog } from './useCatalog';

export function toQueryCatalog(properties: readonly PropertyDefDTO[], students: readonly StudentDTO[]): QueryCatalog {
  return {
    properties: properties.map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      nested: d.nested,
      appliesProblem: d.appliesProblem,
      appliesMaterial: d.appliesMaterial,
      archived: d.archived,
      options: d.options.map((o) => ({ id: o.id, parentId: o.parentId, path: o.path })),
    })),
    students: students.map((s) => ({ id: s.id, name: s.name })),
  };
}

export interface QueryContext {
  catalog: Catalog;
  qc: QueryCatalog;
  students: StudentDTO[];
  /** 目录已加载（名称解析可信） */
  ready: boolean;
}

/** 当前的查询目录（属性、学生），以及补全用的标签与字典。 */
export function useQueryContext(): QueryContext {
  const catalog = useCatalog();
  const students = useStudents(true);
  const list = students.data ?? [];
  const qc = useMemo(() => toQueryCatalog(catalog.properties, list), [catalog.properties, list]);
  return { catalog, qc, students: list, ready: catalog.properties.length > 0 && students.isSuccess };
}

export function tagCondition(path: string | null): string {
  if (path === null) return '标签:无';
  return /[\s"“”()（）:：,，|｜#]/u.test(path) ? `标签:${formatValue(path)}` : `#${path}`;
}

export function dictCondition(kind: 'subject' | 'stage', value: string | null): string {
  return fieldText(kind === 'subject' ? '学科' : '学段', [value === null ? '无' : value]);
}

/** 属性取值的条件文本：选项（路径）、未设置、勾选 */
export function propValueText(def: PropertyDefDTO, value: string): string {
  if (value === NONE_VALUE) return '无';
  if (value === TRUE_VALUE) return '是';
  return formatValue(def.options.find((o) => o.id === value)?.path ?? value);
}

export function propCondition(def: PropertyDefDTO, values: readonly string[]): string {
  return `${propertyKey(def)}:${values.map((v) => propValueText(def, v)).join(',')}`;
}

/** 地址栏里是否还有旧的筛选参数（需要转成查询文本） */
export function hasLegacyFilters(f: ListFilters): boolean {
  return Boolean(f.subject || f.stage || f.tagPaths.length || f.tagIds.length || f.untagged || f.props.length || f.attempt);
}

/** 旧参数 → 查询文本（放在原查询前面），并去掉这些参数。student 参数保留为“按学生查看”的上下文。 */
export function migrateLegacyFilters(f: ListFilters, ctx: QueryContext): ListFilters {
  const tagPaths = [...f.tagPaths, ...f.tagIds.map((id) => ctx.catalog.tags.find((t) => t.id === id)?.name).filter((n): n is string => Boolean(n))];
  const q: Q = andQ([filtersToAst({ ...f, tagPaths, tagIds: [] })]);
  const text = serializeQuery(q, ctx.qc).text;
  return {
    ...f,
    q: [text, f.q].filter(Boolean).join(' ').slice(0, 1000),
    subject: '',
    stage: '',
    tagPaths: [],
    tagIds: [],
    untagged: false,
    props: [],
    attempt: '',
  };
}

export { hasActiveFilters };
