/** 测试用的 SSE 读取器：从 fetch 响应里逐条解析事件。 */
export interface SseEvent {
  event: string;
  id?: string;
  data: string;
}

export interface SseReader {
  /** 等待下一条满足条件的事件（跳过其他事件）；超时报错 */
  next(pred?: (e: SseEvent) => boolean, timeoutMs?: number): Promise<SseEvent>;
  /** 在 ms 内收到的全部事件 */
  collect(ms: number): Promise<SseEvent[]>;
  close(): Promise<void>;
}

export function readSse(res: Response): SseReader {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const queue: SseEvent[] = [];
  const w: { fn: (() => void) | null } = { fn: null };
  let closed = false;
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const e: SseEvent = { event: 'message', data: '' };
          const data: string[] = [];
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            const [k, ...rest] = line.split(':');
            const v = rest.join(':').replace(/^ /, '');
            if (k === 'event') e.event = v;
            else if (k === 'id') e.id = v;
            else if (k === 'data') data.push(v);
          }
          if (!data.length && e.event === 'message') continue;
          e.data = data.join('\n');
          queue.push(e);
          w.fn?.();
        }
      }
    } catch {
      // 连接被取消
    } finally {
      closed = true;
      w.fn?.();
    }
  })();
  const wait = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        w.fn = null;
        resolve();
      }, ms);
      w.fn = () => {
        clearTimeout(t);
        w.fn = null;
        resolve();
      };
    });
  return {
    async next(pred = () => true, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const i = queue.findIndex(pred);
        if (i >= 0) return queue.splice(0, i + 1).pop()!;
        if (closed) throw new Error('SSE 连接已关闭');
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`等待 SSE 事件超时；已收到：${JSON.stringify(queue)}`);
        await wait(left);
      }
    },
    async collect(ms) {
      await new Promise((r) => setTimeout(r, ms));
      return queue.splice(0);
    },
    async close() {
      await reader.cancel().catch(() => undefined);
    },
  };
}
