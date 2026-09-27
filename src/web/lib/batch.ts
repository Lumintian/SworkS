/** 前端批量操作：调用批量接口、刷新缓存并通知其他标签页，生成可撤销的反向操作。 */
import type { BatchAction, BatchResultDTO } from '@shared/api';
import { sendJSON } from './api';
import type { Collection } from './queries';
import { invalidateWrites } from './queryClient';

export async function runBatch(collection: Collection, ids: readonly string[], action: BatchAction): Promise<BatchResultDTO> {
  const r = await sendJSON<BatchResultDTO>('POST', `/api/${collection}/batch`, { ids, action });
  invalidateWrites({ [collection]: r.changed });
  return r;
}

/**
 * 撤销：对实际变化的对象执行反向操作。只支持能精确还原的操作
 * （加/移除标签、移到回收站/恢复、整理状态）；学科/学段等会覆盖原值的操作不提供撤销。
 */
export function inverseAction(action: BatchAction, result: BatchResultDTO, removedTagNames?: string[]): BatchAction | null {
  if (result.changed.length === 0) return null;
  switch (action.op) {
    // 只处理单个标签：多个标签时，变化的对象可能原本就有其中一部分，反向操作会多删/多加
    case 'addTags':
      return action.names.length === 1 && result.tagIds?.length === 1 ? { op: 'removeTags', tagIds: result.tagIds } : null;
    case 'removeTags':
      return action.tagIds.length === 1 && removedTagNames?.length === 1 ? { op: 'addTags', names: removedTagNames } : null;
    case 'trash':
      return { op: 'restore' };
    case 'restore':
      return { op: 'trash' };
    case 'setStatus':
      return { op: 'setStatus', status: action.status === 'inbox' ? 'active' : 'inbox' };
    default:
      return null;
  }
}

/** 批量结果的简短描述。 */
export function describeBatch(result: BatchResultDTO, verb: string): string {
  const parts = [`${verb}${result.changed.length} 项`];
  if (result.unchanged) parts.push(`${result.unchanged} 项无需改动`);
  if (result.skipped) parts.push(`${result.skipped} 项在回收站中已跳过`);
  return parts.join('，');
}
