/** 提供构建后的前端文件；受控路径，禁止目录穿越；未知路由回退到 index.html。 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Handler } from 'hono';
import { isInside } from '../fsutil.js';
import { PAGE_CSP } from './security.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function send(file: string, extraHeaders: Record<string, string>): Response {
  const ext = path.extname(file).toLowerCase();
  const stream = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream;
  return new Response(stream, {
    headers: { 'content-type': MIME[ext] ?? 'application/octet-stream', ...extraHeaders },
  });
}

export function serveWeb(webDir: string | null): Handler {
  const root = webDir ? path.resolve(webDir) : null;
  const index = root ? path.join(root, 'index.html') : null;
  return (c) => {
    if (!root || !index || !fs.existsSync(index)) {
      return c.text('SworkS 前端尚未构建。请先运行 pnpm build，或使用 pnpm dev 进行开发。', 503);
    }
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.text('Bad Request', 400);
    }
    if (rel.includes('\0')) return c.text('Bad Request', 400);
    const candidate = path.resolve(root, `.${path.posix.normalize(rel)}`);
    if (candidate !== root && isInside(root, candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      const hashed = /^\/assets\//.test(rel);
      return send(candidate, {
        'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
        ...(candidate.endsWith('.html') ? { 'content-security-policy': PAGE_CSP } : {}),
      });
    }
    // 带扩展名的缺失资源直接 404，其余交给前端路由
    if (path.extname(rel)) return c.text('Not Found', 404);
    return send(index, { 'cache-control': 'no-cache', 'content-security-policy': PAGE_CSP });
  };
}
