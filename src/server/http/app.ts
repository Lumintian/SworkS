/**
 * HTTP 应用的组合：安全中间件 → 请求体上限 → 各路由模块（`http/routes/`）→ 未知 /api 返回 404 → 静态页面。
 * 路由只做参数校验与调用服务，业务逻辑都在 `services/`。
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { CLIENT_HEADER } from '../../shared/constants.js';
import type { AppContext } from '../context.js';
import { originStore } from '../events/changes.js';
import { AppError, toAppError } from '../errors.js';
import type { RegisterRoutes } from './helpers.js';
import * as assets from './routes/assets.js';
import * as backup from './routes/backup.js';
import * as events from './routes/events.js';
import * as ingest from './routes/ingest.js';
import * as materials from './routes/materials.js';
import * as problems from './routes/problems.js';
import * as properties from './routes/properties.js';
import * as savedSearches from './routes/savedSearches.js';
import * as session from './routes/session.js';
import * as settings from './routes/settings.js';
import * as students from './routes/students.js';
import * as taxonomy from './routes/taxonomy.js';
import { securityMiddleware } from './security.js';
import { serveWeb } from './static.js';

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const ROUTES: RegisterRoutes[] = [session, events, taxonomy, students, properties, problems, materials, savedSearches, ingest, assets, backup, settings].map((m) => m.register);

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    const e = toAppError(err);
    if (e.status >= 500) ctx.log.error(`[${e.code}] ${e.message}${e.cause ? ` — ${String((e.cause as Error).message ?? e.cause)}` : ''}`);
    return c.json(e.toBody(), e.status as 400);
  });

  app.use('*', securityMiddleware(ctx));
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: ctx.limits.maxRequestBytes,
      onError: (c) => c.json(new AppError('TOO_LARGE', '请求体过大').toBody(), 413),
    }),
  );

  // 写请求在“页面”来源下运行，变更事件据此带上发起的标签页 ID
  app.use('/api/*', (c, next) => {
    const m = c.req.method;
    if (m === 'GET' || m === 'HEAD') return next();
    const id = c.req.header(CLIENT_HEADER);
    return originStore.run({ kind: 'web', ...(id && CLIENT_ID_RE.test(id) ? { clientId: id } : {}) }, next);
  });

  for (const register of ROUTES) register(app, ctx);

  app.all('/api/*', () => {
    throw new AppError('NOT_FOUND', '接口不存在');
  });

  app.get('*', serveWeb(ctx.webDir));
  return app;
}
