/**
 * MCP：`/mcp`（Streamable HTTP，鉴权在 security.ts）与页面用的 `/api/mcp` 设置接口。
 * MCP 的写入在 {kind:'mcp'} 来源下运行，经事件推送即时刷新打开着的页面。
 */
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { McpStatusDTO } from '../../../shared/api.js';
import type { AppContext } from '../../context.js';
import { AppError } from '../../errors.js';
import { originStore } from '../../events/changes.js';
import { newMcpToken, saveMcpConfig } from '../../mcp/config.js';
import { appRoot } from '../../paths.js';
import { createSworksMcpHandler } from '../../mcp/server.js';
import { body, type RegisterRoutes } from '../helpers.js';

const MCP_MAX_BYTES = 4 * 1024 * 1024;

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: z.enum(['read', 'write']).optional(),
    regenerateToken: z.boolean().optional(),
  })
  .strict();

export function mcpStatus(ctx: AppContext): McpStatusDTO {
  const url = `${ctx.security.address}/mcp`;
  const token = ctx.mcp.token;
  return {
    enabled: ctx.mcp.enabled,
    mode: ctx.mcp.mode,
    url,
    token,
    claudeCommand: `claude mcp add --transport http sworks ${url} --header "Authorization: Bearer ${token}"`,
    stdioConfig: JSON.stringify(
      { mcpServers: { sworks: { command: 'pnpm', args: ['--dir', appRoot(), 'mcp', '--', '--data-dir', ctx.paths.root] } } },
      null,
      2,
    ),
    dataDir: ctx.paths.root,
  };
}

/** /mcp：放在静态页面兜底之前注册 */
export const registerMcpEndpoint: RegisterRoutes = (app, ctx) => {
  const handler = createSworksMcpHandler(ctx);
  app.use(
    '/mcp',
    bodyLimit({
      maxSize: MCP_MAX_BYTES,
      onError: (c) => c.json(new AppError('TOO_LARGE', '请求体过大').toBody(), 413),
    }),
  );
  app.all('/mcp', (c) => originStore.run({ kind: 'mcp' }, () => handler.fetch(c.req.raw)));
};

export const register: RegisterRoutes = (app, ctx) => {
  app.get('/api/mcp', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json(mcpStatus(ctx));
  });
  app.post('/api/mcp', async (c) => {
    const input = await body(c, updateSchema);
    const next = { ...ctx.mcp };
    if (input.mode) next.mode = input.mode;
    if (input.enabled !== undefined) next.enabled = input.enabled;
    if (input.regenerateToken || (next.enabled && !next.token)) next.token = newMcpToken();
    await saveMcpConfig(ctx.paths, next);
    ctx.mcp = next;
    c.header('Cache-Control', 'no-store');
    return c.json(mcpStatus(ctx));
  });
};
