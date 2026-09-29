/** 题目：列表、整体保存、回收站、笔记恢复。 */
import type { Context } from 'hono';
import { batchSchema, problemCreateSchema, problemUpdateSchema } from '../../../shared/api.js';
import type { AppContext } from '../../context.js';
import { AppError } from '../../errors.js';
import { runBatch } from '../../services/batch.js';
import { createProblem, loadProblem, restoreNote, setDeleted, updateProblem } from '../../services/entities.js';
import type { OwnerKind } from '../../services/rows.js';
import { listEntities, listIds } from '../../services/search.js';
import { body, listQuery, uuidParam, type RegisterRoutes } from '../helpers.js';

/** 列表接口：`fields=ids` 时只返回符合条件的 ID（与列表同样的筛选与排序）。 */
export function listRoute(ctx: AppContext, kind: OwnerKind) {
  return (c: Context) => {
    const q = listQuery(c);
    return c.json(c.req.query('fields') === 'ids' ? listIds(ctx.db, kind, q) : listEntities(ctx.db, kind, q));
  };
}

export const register: RegisterRoutes = (app, ctx) => {
  app.get('/api/problems', listRoute(ctx, 'problem'));
  app.post('/api/problems/batch', async (c) => {
    const input = await body(c, batchSchema);
    return c.json(runBatch(ctx.db, 'problem', input.ids, input.action));
  });
  app.post('/api/problems', async (c) => {
    const input = await body(c, problemCreateSchema);
    const r = createProblem(ctx, input.id.toLowerCase(), input);
    return c.json(r, r.created ? 201 : 200);
  });
  app.get('/api/problems/:id', (c) => {
    const p = loadProblem(ctx.db, uuidParam(c));
    if (!p) throw new AppError('NOT_FOUND', '题目不存在');
    return c.json(p);
  });
  app.put('/api/problems/:id', async (c) => {
    const input = await body(c, problemUpdateSchema);
    return c.json(updateProblem(ctx, uuidParam(c), input.expectedVersion, input));
  });
  app.delete('/api/problems/:id', (c) => c.json({ version: setDeleted(ctx, 'problem', uuidParam(c), true) }));
  app.post('/api/problems/:id/restore', (c) => c.json({ version: setDeleted(ctx, 'problem', uuidParam(c), false) }));
  app.post('/api/notes/:id/restore', (c) => c.json(restoreNote(ctx, uuidParam(c))));
};
