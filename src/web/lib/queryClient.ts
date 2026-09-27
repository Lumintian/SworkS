/** 列表、导航计数与字典的请求缓存（TanStack Query）。编辑页的整份草稿不走这里。 */
import { QueryClient } from '@tanstack/react-query';
import { broadcastWrite, onWrite, type WriteEvent } from './broadcast';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 15_000,
    },
  },
});

/** 写入成功后调用：让列表、导航计数、字典与标签全部重新获取，并通知其他标签页。 */
export function invalidateWrites(e: WriteEvent = {}): void {
  broadcastWrite(e);
}

// 本页与其他标签页的写入都会让缓存失效
onWrite(() => {
  void queryClient.invalidateQueries({ queryKey: ['list'] });
  void queryClient.invalidateQueries({ queryKey: ['nav'] });
  void queryClient.invalidateQueries({ queryKey: ['catalog'] });
  void queryClient.invalidateQueries({ queryKey: ['manage'] });
  void queryClient.invalidateQueries({ queryKey: ['students'] });
  void queryClient.invalidateQueries({ queryKey: ['attempts'] });
  void queryClient.invalidateQueries({ queryKey: ['entity'] });
});
