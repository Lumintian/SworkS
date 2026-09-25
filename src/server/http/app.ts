import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import {
  deriveProblemSchema,
  exportMarkdownSchema,
  materialCreateSchema,
  materialUpdateSchema,
  problemCreateSchema,
  problemUpdateSchema,
  rawTextInputSchema,
  remoteImageCreateSchema,
  type SessionDTO,
} from '../../shared/api.js';
import { isUuid } from '../../shared/assetRef.js';
import { APP_VERSION, MATERIAL_STATUSES, type MaterialStatus } from '../../shared/constants.js';
import type { AppContext } from '../context.js';
import { schemaVersion } from '../db/migrations.js';
import { AppError, toAppError } from '../errors.js';
import { backupFilePath, createBackup, lastBackupAt, listBackups } from '../services/backup.js';
import { getDictionary, getTrash, listTags } from '../services/catalog.js';
import {
  createMaterial,
  createProblem,
  deriveProblemFromMaterial,
  loadMaterial,
  loadProblem,
  restoreNote,
  setDeleted,
  updateMaterial,
  updateProblem,
} from '../services/entities.js';
import { exportProblemsMarkdown } from '../services/exportMarkdown.js';
import { getRemoteImage, ingestImage, ingestRemoteImageUrl, ingestText, ingestTextFile } from '../services/ingest.js';
import { listEntities, type ListQuery } from '../services/search.js';
import type { AssetRow } from '../services/assetStore.js';
import { securityMiddleware } from './security.js';
import { serveWeb } from './static.js';

function parse<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new AppError('VALIDATION', `请求数据无效：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(), {
      details: r.error.issues.slice(0, 5),
    });
  }
  return r.data;
}

async function jsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError('VALIDATION', '请求体不是有效 JSON');
  }
}

function uuidParam(c: Context, name = 'id'): string {
  const v = c.req.param(name) ?? '';
  if (!isUuid(v)) throw new AppError('NOT_FOUND', '对象不存在');
  return v.toLowerCase();
}

async function fileFromForm(c: Context): Promise<{ data: Uint8Array; name: string | null; blockId: string | null }> {
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

function listQuery(c: Context): ListQuery {
  const q = c.req.query();
  const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  const tagIds = (q.tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(isUuid);
  return {
    q: q.q?.slice(0, 500),
    subject: q.subject || undefined,
    stage: q.stage || undefined,
    tagIds,
    sort: q.sort === 'updated' ? 'updated' : 'created',
    offset: num(q.offset),
    limit: num(q.limit),
    status: MATERIAL_STATUSES.includes(q.status as MaterialStatus) ? (q.status as MaterialStatus) : undefined,
  };
}

function fileResponse(file: string, headers: Record<string, string>): Response {
  const stream = Readable.toWeb(fs.createReadStream(file)) as unknown as ReadableStream;
  return new Response(stream, { status: 200, headers });
}

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    const e = toAppError(err);
    if (e.status >= 500) ctx.log.error(`[${e.code}] ${e.message}${e.cause ? ` — ${String((e.cause as Error).message ?? e.cause)}` : ''}`);
    return c.json({ error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } }, e.status as 400);
  });

  app.use('*', securityMiddleware(ctx));
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: ctx.limits.maxRequestBytes,
      onError: (c) => c.json({ error: { code: 'TOO_LARGE', message: '请求体过大' } }, 413),
    }),
  );

  // ------------------------------------------------------------ 会话与元信息
  app.get('/api/session', (c) => {
    const body: SessionDTO = {
      csrfToken: ctx.csrfToken,
      appVersion: APP_VERSION,
      schemaVersion: schemaVersion(ctx.db),
      libraryId: ctx.libraryId,
      dataDir: ctx.paths.root,
      address: ctx.security.address,
      lastBackupAt: lastBackupAt(ctx),
      limits: {
        maxImageBytes: ctx.limits.maxImageBytes,
        remoteTimeoutMs: ctx.limits.remoteTimeoutMs,
        maxRedirects: ctx.limits.maxRedirects,
        allowFakeIpDns: ctx.fetchPolicy.allowFakeIpRange === true,
      },
    };
    c.header('Cache-Control', 'no-store');
    return c.json(body);
  });
  app.get('/api/dict', (c) => c.json(getDictionary(ctx.db)));
  app.get('/api/tags', (c) => c.json(listTags(ctx.db)));
  app.get('/api/trash', (c) => c.json(getTrash(ctx.db)));

  // ------------------------------------------------------------ 题目
  app.get('/api/problems', (c) => c.json(listEntities(ctx.db, 'problem', listQuery(c))));
  app.post('/api/problems', async (c) => {
    const input = parse(problemCreateSchema, await jsonBody(c));
    const r = createProblem(ctx, input.id.toLowerCase(), input);
    return c.json(r, r.created ? 201 : 200);
  });
  app.get('/api/problems/:id', (c) => {
    const p = loadProblem(ctx.db, uuidParam(c));
    if (!p) throw new AppError('NOT_FOUND', '题目不存在');
    return c.json(p);
  });
  app.put('/api/problems/:id', async (c) => {
    const input = parse(problemUpdateSchema, await jsonBody(c));
    return c.json(updateProblem(ctx, uuidParam(c), input.expectedVersion, input));
  });
  app.delete('/api/problems/:id', (c) => c.json({ version: setDeleted(ctx, 'problem', uuidParam(c), true) }));
  app.post('/api/problems/:id/restore', (c) => c.json({ version: setDeleted(ctx, 'problem', uuidParam(c), false) }));
  app.post('/api/notes/:id/restore', (c) => c.json(restoreNote(ctx, uuidParam(c))));

  // ------------------------------------------------------------ 资料
  app.get('/api/materials', (c) => c.json(listEntities(ctx.db, 'material', listQuery(c))));
  app.post('/api/materials', async (c) => {
    const input = parse(materialCreateSchema, await jsonBody(c));
    const r = createMaterial(ctx, input.id.toLowerCase(), input);
    return c.json(r, r.created ? 201 : 200);
  });
  app.get('/api/materials/:id', (c) => {
    const m = loadMaterial(ctx.db, uuidParam(c));
    if (!m) throw new AppError('NOT_FOUND', '资料不存在');
    return c.json(m);
  });
  app.put('/api/materials/:id', async (c) => {
    const input = parse(materialUpdateSchema, await jsonBody(c));
    return c.json(updateMaterial(ctx, uuidParam(c), input.expectedVersion, input));
  });
  app.delete('/api/materials/:id', (c) => c.json({ version: setDeleted(ctx, 'material', uuidParam(c), true) }));
  app.post('/api/materials/:id/restore', (c) => c.json({ version: setDeleted(ctx, 'material', uuidParam(c), false) }));
  app.post('/api/materials/:id/derive', async (c) => {
    const input = parse(deriveProblemSchema, await jsonBody(c));
    const r = deriveProblemFromMaterial(ctx, uuidParam(c), input);
    return c.json(r, r.created ? 201 : 200);
  });

  // ------------------------------------------------------------ 输入与附件
  app.post('/api/uploads/image', async (c) => {
    const f = await fileFromForm(c);
    return c.json(await ingestImage(ctx, f.data, f.name, f.blockId), 201);
  });
  app.post('/api/uploads/text-file', async (c) => {
    const f = await fileFromForm(c);
    return c.json(await ingestTextFile(ctx, f.data, f.name ?? 'untitled.txt', f.blockId), 201);
  });
  app.post('/api/raw-inputs/text', async (c) => {
    const input = parse(rawTextInputSchema, await jsonBody(c));
    return c.json(ingestText(ctx, input.text, input.blockId ?? null), 201);
  });
  app.post('/api/remote-images', async (c) => {
    const input = parse(remoteImageCreateSchema, await jsonBody(c));
    return c.json(await ingestRemoteImageUrl(ctx, input.url, input.blockId ?? null), 201);
  });
  app.get('/api/remote-images/:id', (c) => c.json(getRemoteImage(ctx, uuidParam(c))));
  app.post('/api/remote-images/:id/retry', async (c) => c.json(await ctx.archiver.archive(uuidParam(c))));
  app.post('/api/remote-images/:id/manual', async (c) => {
    const id = uuidParam(c);
    const f = await fileFromForm(c);
    return c.json(await ctx.archiver.manualUpload(id, f.data, f.name));
  });
  app.get('/api/assets/:id', (c) => {
    const row = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(uuidParam(c)) as AssetRow | undefined;
    if (!row) throw new AppError('NOT_FOUND', '附件不存在');
    const file = ctx.store.absolutePath(row.rel_path);
    if (!fs.existsSync(file)) throw new AppError('NOT_FOUND', '附件文件缺失');
    const isImage = row.mime.startsWith('image/');
    return fileResponse(file, {
      'content-type': isImage ? row.mime : `${row.mime}; charset=utf-8`,
      'content-length': String(row.size),
      'cache-control': 'private, max-age=31536000, immutable',
      'content-security-policy': "default-src 'none'; sandbox",
      ...(isImage ? {} : { 'content-disposition': 'attachment' }),
    });
  });

  // ------------------------------------------------------------ 备份与导出
  app.get('/api/backups', async (c) => c.json({ backups: await listBackups(ctx), lastBackupAt: lastBackupAt(ctx) }));
  app.post('/api/backups', async (c) => c.json(await createBackup(ctx), 201));
  app.get('/api/backups/:name', (c) => {
    const name = c.req.param('name');
    const file = backupFilePath(ctx, name);
    return fileResponse(file, {
      'content-type': 'application/zip',
      'content-length': String(fs.statSync(file).size),
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    });
  });
  app.post('/api/export/markdown', async (c) => {
    const input = parse(exportMarkdownSchema, await jsonBody(c));
    const out = await exportProblemsMarkdown(ctx, input.problemIds);
    const data = await fsp.readFile(out.zipPath);
    await fsp.rm(out.zipPath, { force: true });
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${out.fileName}"`,
        'x-sworks-export-warnings': String(out.warnings.length),
        'cache-control': 'no-store',
      },
    });
  });

  app.all('/api/*', () => {
    throw new AppError('NOT_FOUND', '接口不存在');
  });

  app.get('*', serveWeb(ctx.webDir));
  return app;
}
