/** 路由共用的小工具：请求体校验、路径参数、上传文件、文件流响应、列表查询参数。 */
import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { Context, Hono } from 'hono';
import type { z } from 'zod';
import { isUuid } from '../../shared/assetRef.js';
import { parseListFilters } from '../../shared/listFilters.js';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import type { ListQuery } from '../services/search.js';

/** 每个路由模块导出的注册函数。 */
export type RegisterRoutes = (app: Hono, ctx: AppContext) => void;

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new AppError('VALIDATION', `请求数据无效：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(), {
      details: r.error.issues.slice(0, 5),
    });
  }
  return r.data;
}

export async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError('VALIDATION', '请求体不是有效 JSON');
  }
}

/** 读取并校验 JSON 请求体。 */
export async function body<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  return parse(schema, await jsonBody(c));
}

export function uuidParam(c: Context, name = 'id'): string {
  const v = c.req.param(name) ?? '';
  if (!isUuid(v)) throw new AppError('NOT_FOUND', '对象不存在');
  return v.toLowerCase();
}

export async function fileFromForm(c: Context): Promise<{ data: Uint8Array; name: string | null; blockId: string | null }> {
  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch {
    throw new AppError('VALIDATION', '上传请求格式无效');
  }
  const file = form.file;
  if (!(file instanceof File)) throw new AppError('VALIDATION', '缺少上传文件');
  const blockId = typeof form.blockId === 'string' && isUuid(form.blockId) ? form.blockId : null;
  return { data: new Uint8Array(await file.arrayBuffer()), name: file.name || null, blockId };
}

/** 以流的方式返回磁盘文件；onDone 在流结束（或出错、被取消）后调用一次，例如删除临时文件。 */
export function fileResponse(file: string, headers: Record<string, string>, onDone?: () => void): Response {
  const stream = fs.createReadStream(file);
  if (onDone) {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      onDone();
    };
    stream.once('close', once);
    stream.once('error', once);
  }
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: 200, headers });
}

export function listQuery(c: Context): ListQuery {
  const url = new URL(c.req.url);
  const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  return {
    ...parseListFilters(url.searchParams),
    offset: num(url.searchParams.get('offset')),
    limit: num(url.searchParams.get('limit')),
  };
}
