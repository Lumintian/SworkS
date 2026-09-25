import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Limits } from './config.js';
import { DEFAULT_HOST } from './config.js';
import { createContext, setListenAddress, type AppContext, type Logger } from './context.js';
import { createApp } from './http/app.js';
import { openLibrary, type OpenedLibrary } from './library.js';
import type { FetchPolicy } from './services/remoteFetch.js';

export interface StartOptions {
  dataDir: string;
  port: number;
  webDir: string | null;
  log: Logger;
  limits?: Partial<Limits>;
  fetchPolicy?: Partial<FetchPolicy>;
  /** 开发模式下 Vite 页面的来源 */
  extraOrigins?: string[];
}

export interface RunningServer {
  url: string;
  port: number;
  ctx: AppContext;
  library: OpenedLibrary;
  close: () => Promise<void>;
}

/** 启动单进程服务：UI、API 与附件读取；仅绑定 127.0.0.1。 */
export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const library = await openLibrary(opts.dataDir, { purpose: 'server' });
  try {
    const ctx = createContext({
      db: library.db,
      paths: library.paths,
      webDir: opts.webDir,
      log: opts.log,
      ...(opts.limits ? { limits: opts.limits } : {}),
      ...(opts.fetchPolicy ? { fetchPolicy: opts.fetchPolicy } : {}),
    });
    const app = createApp(ctx);
    const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
      const s = serve({ fetch: app.fetch, port: opts.port, hostname: DEFAULT_HOST });
      s.once('error', (err: NodeJS.ErrnoException) => {
        reject(
          err.code === 'EADDRINUSE'
            ? new Error(`端口 ${opts.port} 已被占用，请使用 --port 指定其他端口`)
            : err,
        );
      });
      s.once('listening', () => resolve(s));
    });
    const port = (server.address() as AddressInfo).port;
    setListenAddress(ctx, port, opts.extraOrigins ?? []);
    ctx.archiver.resumePending();
    let closed = false;
    return {
      url: `http://127.0.0.1:${port}`,
      port,
      ctx,
      library,
      close: async () => {
        if (closed) return;
        closed = true;
        ctx.archiver.stop();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
        });
        library.close();
      },
    };
  } catch (err) {
    library.close();
    throw err;
  }
}
