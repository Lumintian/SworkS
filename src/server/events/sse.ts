/**
 * 把变更事件推送给页面（Server-Sent Events）。
 * - 每条事件带递增的序号（SSE id）；保留最近 500 条，断线重连时按 Last-Event-ID 补发；
 *   超出范围（或服务已重启）时发 reset，页面全部重新加载。
 * - hello 事件带 bootId：页面发现 bootId 变了就知道服务重启过。
 */
import { randomUUID } from 'node:crypto';
import type { EventBus } from './bus.js';
import { CHANGE_EVENT_TYPES, type ChangeEventType, type ServerEvents } from './types.js';

export interface SseEntry {
  id: number;
  data: string;
}

const BUFFER_SIZE = 500;

export class SseHub {
  readonly bootId = randomUUID();
  private seq = 0;
  private readonly buffer: SseEntry[] = [];
  private readonly listeners = new Set<(e: SseEntry) => void>();
  private readonly closers = new Set<() => void>();

  constructor(bus: EventBus) {
    bus.onAny((type, payload) => {
      if (!(CHANGE_EVENT_TYPES as readonly string[]).includes(type)) return;
      this.push(type as ChangeEventType, payload as ServerEvents[ChangeEventType]);
    });
  }

  get lastId(): number {
    return this.seq;
  }

  private push<K extends ChangeEventType>(type: K, payload: ServerEvents[K]): void {
    const entry = { id: ++this.seq, data: JSON.stringify({ type, ...payload }) };
    this.buffer.push(entry);
    if (this.buffer.length > BUFFER_SIZE) this.buffer.shift();
    for (const l of this.listeners) l(entry);
  }

  /** lastId 之后的事件；无法补齐（太旧、来自上一次启动）时返回 null。 */
  since(lastId: number): SseEntry[] | null {
    if (lastId === this.seq) return [];
    if (lastId > this.seq) return null;
    const oldest = this.buffer[0]?.id ?? this.seq + 1;
    if (lastId + 1 < oldest) return null;
    return this.buffer.filter((e) => e.id > lastId);
  }

  subscribe(fn: (e: SseEntry) => void, onClose: () => void): () => void {
    this.listeners.add(fn);
    this.closers.add(onClose);
    return () => {
      this.listeners.delete(fn);
      this.closers.delete(onClose);
    };
  }

  /** 服务关闭：结束所有推送连接。 */
  close(): void {
    for (const c of [...this.closers]) c();
    this.listeners.clear();
    this.closers.clear();
  }
}
