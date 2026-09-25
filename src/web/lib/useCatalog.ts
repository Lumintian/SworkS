import { useEffect, useState } from 'react';
import type { TagDTO } from '@shared/api';
import { getJSON } from './api';

interface Catalog {
  subjects: string[];
  stages: string[];
  tags: TagDTO[];
}

let cache: Catalog | null = null;
const listeners = new Set<(c: Catalog) => void>();

export async function refreshCatalog(): Promise<void> {
  try {
    const [dict, tags] = await Promise.all([
      getJSON<{ subjects: string[]; stages: string[] }>('/api/dict'),
      getJSON<TagDTO[]>('/api/tags'),
    ]);
    cache = { ...dict, tags };
    for (const l of listeners) l(cache);
  } catch {
    // 字典只影响候选项，失败时保持原状
  }
}

/** 学科/学段字典与已有标签（用于候选与筛选）。 */
export function useCatalog(): Catalog {
  const [c, setC] = useState<Catalog>(cache ?? { subjects: [], stages: [], tags: [] });
  useEffect(() => {
    listeners.add(setC);
    if (!cache) void refreshCatalog();
    return () => {
      listeners.delete(setC);
    };
  }, []);
  return c;
}
