/**
 * 接收服务端推送的变更（GET /api/events，SSE），让 MCP、插件或其他浏览器的写入也能即时刷新页面。
 * 浏览器对同一主机只开 6 条 HTTP/1.1 连接，所以用 Web Locks 选出唯一一个标签页持有 EventSource，
 * 再经 BroadcastChannel 转发给其他标签页；持有者关闭后锁自动交给下一个标签页。
 * 不支持 Web Locks 的浏览器维持原状（只有同浏览器标签页之间的通知）。
 */
import { relayServerWrite, type WriteEvent } from './broadcast';

interface EntityRef {
  id: string;
  version: number;
}

type ServerChange =
  | { type: 'entities.changed'; problems: EntityRef[]; materials: EntityRef[]; origin: { kind: string; clientId?: string } }
  | { type: 'lessons.changed'; lessons: EntityRef[]; origin: { kind: string; clientId?: string } }
  | { type: 'catalog.changed' | 'attempts.changed' | 'rawInputs.created' | 'remoteImages.changed'; origin: { kind: string; clientId?: string } };

function toWriteEvent(c: ServerChange): WriteEvent {
  const originClient = c.origin.kind === 'web' ? c.origin.clientId : undefined;
  if (c.type === 'entities.changed') {
    const versions: Record<string, number> = {};
    for (const r of [...c.problems, ...c.materials]) versions[r.id] = r.version;
    return { problems: c.problems.map((r) => r.id), materials: c.materials.map((r) => r.id), versions, ...(originClient ? { originClient } : {}) };
  }
  if (c.type === 'lessons.changed') {
    const versions: Record<string, number> = {};
    for (const r of c.lessons) versions[r.id] = r.version;
    return { problems: [], materials: [], lessons: c.lessons.map((r) => r.id), versions, ...(originClient ? { originClient } : {}) };
  }
  // 不涉及具体题目/资料：列表、导航与目录重新获取，编辑页不受影响
  return { problems: [], materials: [], ...(originClient ? { originClient } : {}) };
}

let started = false;

export function startServerEvents(): void {
  if (started) return;
  started = true;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof EventSource === 'undefined') return;
  void locks.request('sworks-events', () => new Promise<void>((release) => hold(release)));
}

/** 持有锁期间保持连接；页面关闭时锁随之释放。 */
function hold(release: () => void): void {
  let bootId: string | null = null;
  const es = new EventSource('/api/events');
  es.addEventListener('hello', (m) => {
    const hello = JSON.parse((m as MessageEvent<string>).data) as { bootId: string };
    // 服务重启过：期间的变更无从得知，全部重新获取
    if (bootId !== null && bootId !== hello.bootId) relayServerWrite({});
    bootId = hello.bootId;
  });
  es.addEventListener('reset', () => relayServerWrite({}));
  es.addEventListener('change', (m) => {
    try {
      relayServerWrite(toWriteEvent(JSON.parse((m as MessageEvent<string>).data) as ServerChange));
    } catch {
      // 忽略无法解析的事件
    }
  });
  window.addEventListener('pagehide', () => {
    es.close();
    release();
  });
}
