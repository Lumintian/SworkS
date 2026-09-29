/** GET /api/events：变更事件推送（只含 ID、版本与来源，不含内容）。 */
import { streamSSE } from 'hono/streaming';
import type { RegisterRoutes } from '../helpers.js';

const HEARTBEAT_MS = 25_000;

export const register: RegisterRoutes = (app, ctx) => {
  app.get('/api/events', (c) => {
    c.header('Cache-Control', 'no-store');
    const hub = ctx.sse;
    const raw = c.req.header('last-event-id');
    const lastId = raw && /^\d{1,15}$/.test(raw) ? Number(raw) : null;
    return streamSSE(c, async (stream) => {
      let done!: () => void;
      const finished = new Promise<void>((r) => (done = r));
      // 先订阅再补发，避免中间漏掉事件；maxSent 保证每条只发一次、按序号递增
      let maxSent = lastId ?? hub.lastId;
      const queue: { id: number; data: string }[] = [];
      let replaying = true;
      const send = async (e: { id: number; data: string }) => {
        if (e.id <= maxSent) return;
        maxSent = e.id;
        await stream.writeSSE({ id: String(e.id), event: 'change', data: e.data }).catch(() => done());
      };
      const off = hub.subscribe(
        (e) => {
          if (replaying) queue.push(e);
          else void send(e);
        },
        () => done(),
      );
      stream.onAbort(() => done());
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ bootId: hub.bootId, seq: hub.lastId }) });
      if (lastId !== null) {
        const missed = hub.since(lastId);
        if (missed === null) {
          maxSent = hub.lastId;
          await stream.writeSSE({ event: 'reset', data: JSON.stringify({ bootId: hub.bootId, seq: hub.lastId }) });
        } else for (const e of missed) await send(e);
      }
      for (const e of queue) await send(e);
      replaying = false;
      const beat = setInterval(() => void stream.write(': ping\n\n').catch(() => done()), HEARTBEAT_MS);
      await finished;
      clearInterval(beat);
      off();
    });
  });
};
