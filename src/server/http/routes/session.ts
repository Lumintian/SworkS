/** 会话、导航计数与回收站。 */
import { getNav, getTrash } from '../../services/catalog.js';
import { getSession } from '../../services/session.js';
import type { RegisterRoutes } from '../helpers.js';

export const register: RegisterRoutes = (app, ctx) => {
  app.get('/api/session', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(getSession(ctx));
  });
  app.get('/api/trash', (c) => c.json(getTrash(ctx.db)));
  app.get('/api/nav', (c) => c.json(getNav(ctx.db, c.req.query('collection') === 'materials' ? 'material' : 'problem')));
};
