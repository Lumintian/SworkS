import fsp from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { Limits } from './config.js';
import { DEFAULT_HOST } from './config.js';
import { createContext, setListenAddress, type AppContext, type Logger } from './context.js';
import { APP_VERSION } from '../shared/constants.js';
import { flushChanges } from './events/changes.js';
import { writeFileAtomic } from './fsutil.js';
import { createApp } from './http/app.js';
import { SERVER_INFO_FILE, serverInfoPath, type ServerInfo } from './serverInfo.js';

export { SERVER_INFO_FILE, serverInfoPath, type ServerInfo } from './serverInfo.js';
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
  const library = await openLibrary(opts.dataDir, { purpose: 'server', log: (m) => opts.log.info(m) });
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
    const url = `http://127.0.0.1:${port}`;
    const infoFile = serverInfoPath(library.paths.root);
    const info: ServerInfo = { pid: process.pid, port, url, bootId: ctx.sse.bootId, startedAt: new Date().toISOString(), appVersion: APP_VERSION };
    try {
      await writeFileAtomic(infoFile, `${JSON.stringify(info, null, 2)}\n`, library.paths.tmp, 0o600);
    } catch (err) {
      opts.log.warn(`无法写入 ${SERVER_INFO_FILE}：${(err as Error).message}`);
    }
    ctx.events.emit('server.started', { url, bootId: ctx.sse.bootId });
    let closed = false;
    return {
      url,
      port,
      ctx,
      library,
      close: async () => {
        if (closed) return;
        closed = true;
        ctx.events.emit('server.stopping', {});
        ctx.archiver.stop();
        flushChanges(ctx.db);
        ctx.sse.close();
        // 只删除自己写的文件（另一个进程不可能同时持有数据目录锁，这里只是保险）
        try {
          const cur = JSON.parse(await fsp.readFile(infoFile, 'utf8')) as Partial<ServerInfo>;
          if (cur.bootId === info.bootId) await fsp.rm(infoFile, { force: true });
        } catch {
          // 文件不存在或已损坏：忽略
        }
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
