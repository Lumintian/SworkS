/**
 * 进程内事件总线。处理器各自在微任务里运行并捕获异常：失败只记日志，永远不影响写入方。
 */
import type { Logger } from '../context.js';
import type { ServerEvents, ServerEventType } from './types.js';

type Handler<K extends ServerEventType> = (payload: ServerEvents[K]) => void | Promise<void>;
type AnyHandler = (type: ServerEventType, payload: ServerEvents[ServerEventType]) => void | Promise<void>;

export class EventBus {
  private readonly handlers = new Map<ServerEventType, Set<Handler<ServerEventType>>>();
  private readonly any = new Set<AnyHandler>();

  constructor(private readonly log: Logger) {}

  on<K extends ServerEventType>(type: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(handler as Handler<ServerEventType>);
    return () => set.delete(handler as Handler<ServerEventType>);
  }

  /** 订阅全部事件（SSE 推送用）。 */
  onAny(handler: AnyHandler): () => void {
    this.any.add(handler);
    return () => this.any.delete(handler);
  }

  emit<K extends ServerEventType>(type: K, payload: ServerEvents[K]): void {
    const run = (fn: () => void | Promise<void>) =>
      queueMicrotask(() => {
        try {
          const r = fn();
          if (r && typeof (r as Promise<void>).catch === 'function') (r as Promise<void>).catch((err: unknown) => this.fail(type, err));
        } catch (err) {
          this.fail(type, err);
        }
      });
    for (const h of this.handlers.get(type) ?? []) run(() => h(payload));
    for (const h of this.any) run(() => h(type, payload));
  }

  private fail(type: string, err: unknown): void {
    this.log.error(`事件处理失败（${type}）：${err instanceof Error ? err.message : String(err)}`);
  }
}
