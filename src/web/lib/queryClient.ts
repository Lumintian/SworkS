/** 列表、导航计数与字典的请求缓存（TanStack Query）。编辑页的整份草稿不走这里。 */
import { QueryClient } from '@tanstack/react-query';
import { broadcastWrite, onWrite, TAB_ID, type WriteEvent } from './broadcast';

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

/**
 * 只改了目录、没有改任何题目/资料内容的写入（字典候选、新建属性、属性改名、选项的新建/改名/移动…）：
 * 列表与目录照样重新获取，其他标签页里开着的编辑页不必逐个重新读取。
 */
export const CATALOG_ONLY: WriteEvent = { problems: [], materials: [] };

const KEYS = ['list', 'nav', 'catalog', 'manage', 'students', 'attempts', 'lessons', 'entity'];
let timer: ReturnType<typeof setTimeout> | null = null;

function invalidateAll(): void {
  for (const k of KEYS) void queryClient.invalidateQueries({ queryKey: [k] });
}

// 本页与其他标签页的写入立即让缓存失效；服务端推送的事件合并 150ms 再失效（一次批量写入可能连着几条事件）
onWrite((e) => {
  if (!e.fromServer) {
    invalidateAll();
    return;
  }
  // 本页自己发出的写入已经在保存成功时处理过
  if (e.originClient === TAB_ID) return;
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    invalidateAll();
  }, 150);
});

