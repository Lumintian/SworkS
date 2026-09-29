import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createContext, setListenAddress, silentLogger, type AppContext } from '../../src/server/context.js';
import { createApp } from '../../src/server/http/app.js';
import { openLibrary, type OpenedLibrary } from '../../src/server/library.js';
import type { FetchPolicy } from '../../src/server/services/remoteFetch.js';
import type { Limits } from '../../src/server/config.js';

export const TEST_PORT = 4821;
export const HOST = `127.0.0.1:${TEST_PORT}`;

/** 真实的 1x1 PNG */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 生成内容互不相同的“PNG”字节（文件头合法，服务端只按文件头识别格式）。 */
export function fakePng(size = 256): Buffer {
  return Buffer.concat([PNG_SIG, randomBytes(size)]);
}

export async function makeTempDir(prefix = 'sworks-test-'): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export interface TestApp {
  dir: string;
  dataDir: string;
  lib: OpenedLibrary;
  ctx: AppContext;
  request: (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  json: <T = any>(method: string, url: string, body?: unknown) => Promise<{ status: number; body: T }>;
  upload: (url: string, data: Uint8Array, filename: string, fields?: Record<string, string>) => Promise<Response>;
  /** 只带 Host 与给定的头（不带 Origin、CSRF），模拟命令行客户端 */
  raw: (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
  close: () => void;
}

export async function makeTestApp(
  opts: { dataDir?: string; fetchPolicy?: Partial<FetchPolicy>; limits?: Partial<Limits> } = {},
): Promise<TestApp> {
  const dir = opts.dataDir ? path.dirname(opts.dataDir) : await makeTempDir();
  const dataDir = opts.dataDir ?? path.join(dir, 'data');
  const lib = await openLibrary(dataDir);
  const ctx = createContext({
    db: lib.db,
    paths: lib.paths,
    log: silentLogger,
    ...(opts.fetchPolicy ? { fetchPolicy: opts.fetchPolicy } : {}),
    ...(opts.limits ? { limits: opts.limits } : {}),
  });
  setListenAddress(ctx, TEST_PORT);
  const app = createApp(ctx);
  const baseHeaders = () => ({ host: HOST, origin: `http://${HOST}`, 'x-sworks-csrf': ctx.csrfToken });
  const request: TestApp['request'] = (method, url, body, headers) =>
    Promise.resolve(
      app.request(url, {
        method,
        headers: { ...baseHeaders(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return {
    dir,
    dataDir,
    lib,
    ctx,
    request,
    json: async (method, url, body) => {
      const res = await request(method, url, body);
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    upload: (url, data, filename, fields = {}) => {
      const form = new FormData();
      form.append('file', new File([new Uint8Array(data)], filename));
      for (const [k, v] of Object.entries(fields)) form.append(k, v);
      return Promise.resolve(app.request(url, { method: 'POST', headers: baseHeaders(), body: form }));
    },
    raw: (method, url, body, headers = {}) =>
      Promise.resolve(
        app.request(url, {
          method,
          headers: { host: HOST, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        }),
      ),
    close: () => {
      ctx.archiver.stop();
      lib.close();
    },
  };
}

export async function uploadImage(t: TestApp, data: Uint8Array = fakePng(), name = 'shot.png') {
  const res = await t.upload('/api/uploads/image', data, name);
  if (res.status !== 201) throw new Error(`upload failed ${res.status} ${await res.text()}`);
  return (await res.json()) as { asset: { id: string; sha256: string; mime: string }; rawInputId: string };
}

export function newId(): string {
  return randomUUID();
}

export function rmrf(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}
