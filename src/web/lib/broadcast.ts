/**
 * 同一浏览器内多个标签页之间的写入通知（BroadcastChannel）。
 * 批量操作、分类管理等写入成功后广播；其他页面据此刷新列表，
 * 已打开的编辑页在保存前就能知道内容已在别处修改，而不是等到 409。
 */

export interface WriteEvent {
  /** 受影响的对象；为空表示范围不定（例如标签改名影响了多类对象） */
  problems?: string[];
  materials?: string[];
  /** 发出事件的标签页，用于忽略自己发出的事件 */
  source?: string;
}

const TAB_ID = Math.random().toString(36).slice(2);
const channel: BroadcastChannel | null = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('sworks-writes');
const localListeners = new Set<(e: WriteEvent, fromOtherTab: boolean) => void>();

channel?.addEventListener('message', (m: MessageEvent<WriteEvent>) => {
  for (const l of localListeners) l(m.data, true);
});

export function broadcastWrite(e: WriteEvent): void {
  const event = { ...e, source: TAB_ID };
  for (const l of localListeners) l(event, false);
  channel?.postMessage(event);
}

export function onWrite(listener: (e: WriteEvent, fromOtherTab: boolean) => void): () => void {
  localListeners.add(listener);
  return () => localListeners.delete(listener);
}
