/**
 * 本机无登录 ≠ 允许任意网页访问本地 API：
 * - 校验 Host（防 DNS 重绑定）；
 * - 修改类请求校验 Origin / Sec-Fetch-Site，并要求 CSRF 令牌头（跨源页面无法读取令牌，也无法无预检地发送自定义头）；
 * - 不返回任何 CORS 头；GET 不修改数据。
 */
import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { CSRF_HEADER } from '../../shared/constants.js';
import type { AppContext } from '../context.js';

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function deny(code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status: 403,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export function securityMiddleware(ctx: AppContext): MiddlewareHandler {
  return async (c, next) => {
    const host = (c.req.header('host') ?? '').toLowerCase();
    if (!ctx.security.allowedHosts.has(host)) {
      return deny('FORBIDDEN_HOST', '拒绝访问：请求的 Host 不是本机地址');
    }
    const method = c.req.method.toUpperCase();
    if (method === 'OPTIONS') return deny('FORBIDDEN_ORIGIN', '不支持跨源访问');
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = c.req.header('origin');
      if (origin !== undefined && !ctx.security.allowedOrigins.has(origin.toLowerCase())) {
        return deny('FORBIDDEN_ORIGIN', '拒绝跨源修改请求');
      }
      const site = c.req.header('sec-fetch-site');
      if (site !== undefined && site !== 'same-origin' && site !== 'none') {
        return deny('FORBIDDEN_ORIGIN', '拒绝跨站修改请求');
      }
      const token = c.req.header(CSRF_HEADER) ?? '';
      if (!safeEqual(token, ctx.csrfToken)) return deny('CSRF', '缺少或无效的 CSRF 令牌，请刷新页面');
    }
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
  };
}

/** 页面 CSP：脚本、样式、字体、图片均只来自本机；不允许外链图片回退。 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');
