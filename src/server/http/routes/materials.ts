/** 资料：列表、整体保存、回收站、从资料建题。 */
import { batchSchema, deriveProblemSchema, materialCreateSchema, materialUpdateSchema } from '../../../shared/api.js';
import { AppError } from '../../errors.js';
import { runBatch } from '../../services/batch.js';
import { createMaterial, deriveProblemFromMaterial, loadMaterial, setDeleted, updateMaterial } from '../../services/entities.js';
import { body, uuidParam, type RegisterRoutes } from '../helpers.js';
import { listRoute } from './problems.js';

export const register: RegisterRoutes = (app, ctx) => {
  app.get('/api/materials', listRoute(ctx, 'material'));
  app.post('/api/materials/batch', async (c) => {
    const input = await body(c, batchSchema);
    return c.json(runBatch(ctx.db, 'material', input.ids, input.action));
  });
  app.post('/api/materials', async (c) => {
    const input = await body(c, materialCreateSchema);
    const r = createMaterial(ctx, input.id.toLowerCase(), input);
    return c.json(r, r.created ? 201 : 200);
  });
  app.get('/api/materials/:id', (c) => {
    const m = loadMaterial(ctx.db, uuidParam(c));
    if (!m) throw new AppError('NOT_FOUND', '资料不存在');
    return c.json(m);
  });
  app.put('/api/materials/:id', async (c) => {
    const input = await body(c, materialUpdateSchema);
    return c.json(updateMaterial(ctx, uuidParam(c), input.expectedVersion, input));
  });
  app.delete('/api/materials/:id', (c) => c.json({ version: setDeleted(ctx, 'material', uuidParam(c), true) }));
  app.post('/api/materials/:id/restore', (c) => c.json({ version: setDeleted(ctx, 'material', uuidParam(c), false) }));
  app.post('/api/materials/:id/derive', async (c) => {
    const input = await body(c, deriveProblemSchema);
    const r = deriveProblemFromMaterial(ctx, uuidParam(c), input);
    return c.json(r, r.created ? 201 : 200);
  });
};
