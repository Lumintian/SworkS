/** 列表、导航计数等查询（TanStack Query）。 */
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import type { AttemptDTO, ListIdsResponse, ListResponse, NavDTO, StudentDetailDTO, StudentDTO } from '@shared/api';
import { PAGE_SIZE } from '@shared/constants';
import { listFiltersToParams, parseListFilters, type ListFilters } from '@shared/listFilters';
import { getJSON } from './api';
import { useRouter } from './router';

export type Collection = 'problems' | 'materials';

export function listParams(filters: Partial<ListFilters>): string {
  return listFiltersToParams(filters).toString();
}

export function useInfiniteList(collection: Collection, filters: ListFilters) {
  const params = listParams(filters);
  return useInfiniteQuery({
    queryKey: ['list', collection, params],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams(params);
      if (!p.has('sort')) p.set('sort', filters.sort);
      p.set('offset', String(pageParam));
      p.set('limit', String(PAGE_SIZE));
      return getJSON<ListResponse>(`/api/${collection}?${p.toString()}`);
    },
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, pg) => n + pg.items.length, 0);
      return loaded < last.total && last.items.length > 0 ? loaded : undefined;
    },
  });
}

/** 与当前筛选相同条件的全部 ID（用于“选择全部 N 项”）。 */
export function fetchAllIds(collection: Collection, filters: ListFilters): Promise<ListIdsResponse> {
  const p = listFiltersToParams(filters);
  p.set('fields', 'ids');
  return getJSON<ListIdsResponse>(`/api/${collection}?${p.toString()}`);
}

export function useNav(collection: Collection) {
  return useQuery({
    queryKey: ['nav', collection],
    queryFn: () => getJSON<NavDTO>(`/api/nav?collection=${collection}`),
  });
}

export function useStudents(includeArchived = false) {
  return useQuery({
    queryKey: ['students', includeArchived],
    queryFn: () => getJSON<StudentDTO[]>(`/api/students${includeArchived ? '?all=1' : ''}`),
  });
}

export function useStudentDetail(id: string) {
  return useQuery({ queryKey: ['students', 'detail', id], queryFn: () => getJSON<StudentDetailDTO>(`/api/students/${id}`) });
}

export function useProblemAttempts(problemId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['attempts', 'problem', problemId],
    queryFn: () => getJSON<AttemptDTO[]>(`/api/attempts?problemId=${problemId}`),
    enabled,
  });
}

/** 上次记录作答时选的学生（浏览器端的便利设置，不是业务数据）。 */
const LAST_STUDENT_KEY = 'sworks.lastStudent';
export function lastStudentId(): string | null {
  try {
    return localStorage.getItem(LAST_STUDENT_KEY);
  } catch {
    return null;
  }
}
export function rememberStudent(id: string): void {
  try {
    localStorage.setItem(LAST_STUDENT_KEY, id);
  } catch {
    // 忽略
  }
}

/** 地址栏里的筛选条件，以及写回地址栏的方法（替换当前历史记录）。 */
export function useListFilters(): [ListFilters, (f: ListFilters) => void] {
  const { path, search, navigate } = useRouter();
  const filters = useMemo(() => parseListFilters(new URLSearchParams(search)), [search]);
  const set = useCallback(
    (f: ListFilters) => {
      const s = listParams({ ...f, status: undefined });
      navigate(`${path}${s ? `?${s}` : ''}`, { replace: true });
    },
    [navigate, path],
  );
  return [filters, set];
}

/** 当前路径对应的集合：资料与收件箱属于资料，其余属于题目。 */
export function collectionOfPath(path: string): Collection {
  return path.startsWith('/materials') || path.startsWith('/inbox') ? 'materials' : 'problems';
}

/** 集合的列表页路径。 */
export function listPathOf(path: string): string {
  if (path.startsWith('/inbox')) return '/inbox';
  return collectionOfPath(path) === 'materials' ? '/materials' : '/problems';
}
