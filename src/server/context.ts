import { randomBytes } from 'node:crypto';
import type { Limits } from './config.js';
import { EventBus } from './events/bus.js';
import { installChangeLog } from './events/changes.js';
import { SseHub } from './events/sse.js';
import { DEFAULT_LIMITS } from './config.js';
import type { DB } from './db/connection.js';
import { getMeta } from './db/migrations.js';
import type { DataPaths } from './paths.js';
import { AssetStore } from './services/assetStore.js';
import { RemoteArchiver } from './services/ingest.js';
import type { FetchPolicy } from './services/remoteFetch.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const consoleLogger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

export interface AppContext {
  db: DB;
  paths: DataPaths;
  limits: Limits;
  store: AssetStore;
  archiver: RemoteArchiver;
  fetchPolicy: FetchPolicy;
  csrfToken: string;
  libraryId: string;
  /** 允许的 Host 头与 Origin，监听端口确定后填入 */
  security: { allowedHosts: Set<string>; allowedOrigins: Set<string>; address: string };
  backupState: { running: boolean };
  /** 构建后的前端目录；为 null 时不提供页面（开发模式由 Vite 提供） */
  webDir: string | null;
  log: Logger;
  /** 进程内事件总线：服务层的变更提交后在这里发出 */
  events: EventBus;
  /** 把变更事件推送给页面 */
  sse: SseHub;
}

export interface ContextOptions {
  db: DB;
  paths: DataPaths;
  limits?: Partial<Limits>;
  fetchPolicy?: Partial<FetchPolicy>;
  webDir?: string | null;
  log?: Logger;
}

export function createContext(opts: ContextOptions): AppContext {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const ctx = {
    db: opts.db,
    paths: opts.paths,
    limits,
    store: new AssetStore(opts.paths, opts.db),
    fetchPolicy: {
      maxBytes: limits.maxImageBytes,
      timeoutMs: limits.remoteTimeoutMs,
      maxRedirects: limits.maxRedirects,
      ...opts.fetchPolicy,
    },
    csrfToken: randomBytes(32).toString('hex'),
    libraryId: getMeta(opts.db, 'library_id') ?? 'unknown',
    security: { allowedHosts: new Set<string>(), allowedOrigins: new Set<string>(), address: '' },
    backupState: { running: false },
    webDir: opts.webDir ?? null,
    log: opts.log ?? consoleLogger,
  } as Omit<AppContext, 'archiver' | 'events' | 'sse'> as AppContext;
  ctx.events = new EventBus(ctx.log);
  ctx.sse = new SseHub(ctx.events);
  installChangeLog(opts.db, ctx.events);
  ctx.archiver = new RemoteArchiver(ctx);
  return ctx;
}

/** 监听地址确定后设置允许的 Host/Origin（仅本机回环）。 */
export function setListenAddress(ctx: AppContext, port: number, extraOrigins: string[] = []): void {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
  // 开发模式：Vite 开发服务器（同样只在本机）代理 /api 时带着它自己的 Host/Origin
  const devHosts = extraOrigins.map((o) => new URL(o)).filter((u) => ['127.0.0.1', 'localhost'].includes(u.hostname)).map((u) => u.host);
  ctx.security.allowedHosts = new Set([...hosts, ...devHosts]);
  ctx.security.allowedOrigins = new Set([...hosts.map((h) => `http://${h}`), ...devHosts.map((h) => `http://${h}`)]);
  ctx.security.address = `http://127.0.0.1:${port}`;
}
