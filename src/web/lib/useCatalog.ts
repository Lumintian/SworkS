import { useQuery } from '@tanstack/react-query';
import type { PropertyDefDTO, TagDTO } from '@shared/api';
import { getJSON } from './api';
import { queryClient } from './queryClient';

export interface Catalog {
  subjects: string[];
  stages: string[];
  tags: TagDTO[];
  /** 未归档的自定义属性（含选项树） */
  properties: PropertyDefDTO[];
}

const EMPTY: Catalog = { subjects: [], stages: [], tags: [], properties: [] };

async function fetchCatalog(): Promise<Catalog> {
  const [dict, tags, properties] = await Promise.all([
    getJSON<{ subjects: string[]; stages: string[] }>('/api/dict'),
    getJSON<TagDTO[]>('/api/tags'),
    getJSON<PropertyDefDTO[]>('/api/properties'),
  ]);
  return { ...dict, tags, properties };
}

/** 适用于某类对象的属性。 */
export function propertiesFor(catalog: Catalog, kind: 'problems' | 'materials'): PropertyDefDTO[] {
  return catalog.properties.filter((p) => (kind === 'problems' ? p.appliesProblem : p.appliesMaterial));
}

export async function refreshCatalog(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: ['catalog'] });
}

/** 学科/学段字典与已有标签（用于候选与筛选）。字典只影响候选项，请求失败时保持空列表。 */
export function useCatalog(): Catalog {
  const q = useQuery({ queryKey: ['catalog'], queryFn: fetchCatalog });
  return q.data ?? EMPTY;
}
