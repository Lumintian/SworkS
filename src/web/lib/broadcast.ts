/**
 * 写入通知：同一浏览器内多个标签页之间（BroadcastChannel），以及服务端推送的变更（见 serverEvents.ts）。
 * 批量操作、分类管理等写入成功后广播；其他页面据此刷新列表，
 * 已打开的编辑页在保存前就能知道内容已在别处修改，而不是等到 409。
 */

export interface WriteEvent {
  /** 受影响的对象；都省略表示范围不定（例如标签改名影响了多类对象），空数组表示不涉及题目/资料 */
  problems?: string[];
  materials?: string[];
  /** 服务端事件带上各对象的当前版本：编辑页据此判断是否需要重新加载 */
  versions?: Record<string, number>;
  /** 服务端事件：发起这次写入的标签页（页面写入时带上 TAB_ID） */
  originClient?: string;
  /** 事件来自服务端推送 */
  fromServer?: boolean;
  /** 发出事件的标签页，用于忽略自己发出的事件 */
  source?: string;
}

/** 本标签页的 ID：写请求带上它（x-sworks-client），服务端事件据此认出“自己发出的修改”。 */
export const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

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

/** 转发一条服务端事件：本页与其他标签页都按“外部写入”处理。 */
export function relayServerWrite(e: WriteEvent): void {
  const event = { ...e, fromServer: true, source: TAB_ID };
  for (const l of localListeners) l(event, true);
  channel?.postMessage(event);
}

export function onWrite(listener: (e: WriteEvent, fromOtherTab: boolean) => void): () => void {
  localListeners.add(listener);
  return () => localListeners.delete(listener);
}
