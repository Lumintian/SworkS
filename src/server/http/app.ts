import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import {
  attemptBatchSchema,
  attemptCreateSchema,
  attemptUpdateSchema,
  studentCreateSchema,
  studentUpdateSchema,
  batchSchema,
  idListSchema,
  optionCreateSchema,
  optionMergeSchema,
  optionMergeManySchema,
  optionMoveManySchema,
  optionMoveSchema,
  optionPathSchema,
  optionUpdateSchema,
  outlineImportSchema,
  propertyCreateSchema,
  propertyUpdateSchema,
  deriveProblemSchema,
  dictRenameSchema,
  dictReorderSchema,
  dictValueSchema,
  dictValuesSchema,
  dictMergeSchema,
  exportMarkdownSchema,
  materialCreateSchema,
  materialUpdateSchema,
  problemCreateSchema,
  problemUpdateSchema,
  rawTextInputSchema,
  remoteImageCreateSchema,
  savedSearchCreateSchema,
  savedSearchReorderSchema,
  savedSearchUpdateSchema,
  tagDeleteSchema,
  tagDeleteManySchema,
  tagMergeSchema,
  tagMoveSchema,
  tagRenameSchema,
  type SessionDTO,
} from '../../shared/api.js';
import { isUuid } from '../../shared/assetRef.js';
import { APP_VERSION, CLIENT_HEADER } from '../../shared/constants.js';
import { parseListFilters } from '../../shared/listFilters.js';
import type { AppContext } from '../context.js';
import { schemaVersion } from '../db/migrations.js';
import { originStore } from '../events/changes.js';
import { AppError, toAppError } from '../errors.js';
import { backupFilePath, createBackup, lastBackupAt, listBackups } from '../services/backup.js';
import { runBatch } from '../services/batch.js';
import { getDictionary, getNav, getTrash, listTags } from '../services/catalog.js';
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
import { listEntities, listIds, type ListQuery } from '../services/search.js';
import { addDictEntry, deleteTagPath, deleteTagPaths, getDictManage, mergeDictValues, mergeTagPaths, moveTagPaths, removeDictEntries, removeDictEntry, renameDictValue, renameTagPath, reorderDict } from '../services/taxonomy.js';
import type { OwnerKind } from '../services/rows.js';
import {
  createOption,
  createPropertyDef,
  deleteOption,
  deleteOptions,
  ensureOptionPath,
  getPropertyDef,
  importOutline,
  listPropertyDefs,
  mergeOption,
  mergeOptions,
  moveOption,
  moveOptions,
  renameOption,
  reorderPropertyDefs,
  setPropertyArchived,
  updatePropertyDef,
} from '../services/properties.js';
import { makeToucher } from '../services/touch.js';
import { register as registerEvents } from './routes/events.js';
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  reorderSavedSearches,
  savedSearchCounts,
  updateSavedSearch,
} from '../services/savedSearches.js';
import {
  createAttempt,
  createAttemptsBatch,
  createStudent,
  getStudentDetail,
  listAttempts,
  listStudents,
  setAttemptDeleted,
  setStudentArchived,
  updateAttempt,
  updateStudent,
} from '../services/students.js';
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
  const url = new URL(c.req.url);
  const num = (v: string | null) => (v && /^\d+$/.test(v) ? Number(v) : undefined);
  return {
    ...parseListFilters(url.searchParams),
    offset: num(url.searchParams.get('offset')),
    limit: num(url.searchParams.get('limit')),
  };
}

/** 列表接口：`fields=ids` 时只返回符合条件的 ID（与列表同样的筛选与排序）。 */
function listRoute(ctx: AppContext, kind: OwnerKind) {
  return (c: Context) => {
    const q = listQuery(c);
    return c.json(c.req.query('fields') === 'ids' ? listIds(ctx.db, kind, q) : listEntities(ctx.db, kind, q));
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

  // 写请求在“页面”来源下运行，变更事件据此带上发起的标签页 ID
  app.use('/api/*', (c, next) => {
    const m = c.req.method;
    if (m === 'GET' || m === 'HEAD') return next();
    const id = c.req.header(CLIENT_HEADER);
    return originStore.run({ kind: 'web', ...(id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? { clientId: id } : {}) }, next);
  });

  // ------------------------------------------------------------ 常用检索
  app.get('/api/saved-searches', (c) => {
    const scope = c.req.query('scope');
    if (scope !== undefined && scope !== 'problem' && scope !== 'material') throw new AppError('VALIDATION', 'scope 应为 problem 或 material');
    return c.json(listSavedSearches(ctx.db, scope as 'problem' | 'material' | undefined));
  });
  app.get('/api/saved-searches/counts', (c) => {
    const scope = c.req.query('scope');
    if (scope !== 'problem' && scope !== 'material') throw new AppError('VALIDATION', 'scope 应为 problem 或 material');
    return c.json(savedSearchCounts(ctx.db, scope));
  });
  app.post('/api/saved-searches/reorder', async (c) => {
    const input = parse(savedSearchReorderSchema, await jsonBody(c));
    reorderSavedSearches(ctx.db, input.scope, input.ids);
    return c.json(listSavedSearches(ctx.db, input.scope));
  });
  app.post('/api/saved-searches', async (c) => {
    const r = createSavedSearch(ctx.db, parse(savedSearchCreateSchema, await jsonBody(c)));
    return c.json(r.savedSearch, r.created ? 201 : 200);
  });
  app.put('/api/saved-searches/:id', async (c) => c.json(updateSavedSearch(ctx.db, uuidParam(c), parse(savedSearchUpdateSchema, await jsonBody(c)))));
  app.post('/api/saved-searches/:id/delete', (c) => {
    deleteSavedSearch(ctx.db, uuidParam(c));
    return c.json({ ok: true });
  });

  registerEvents(app, ctx);

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
  app.get('/api/tags', (c) => c.json(listTags(ctx.db, { all: c.req.query('all') === '1' })));
  app.get('/api/trash', (c) => c.json(getTrash(ctx.db)));
  app.get('/api/nav', (c) => c.json(getNav(ctx.db, c.req.query('collection') === 'materials' ? 'material' : 'problem')));

  // ------------------------------------------------------------ 分类管理（标签、学科/学段字典）
  app.post('/api/tags/rename', async (c) => {
    const input = parse(tagRenameSchema, await jsonBody(c));
    return c.json(renameTagPath(ctx.db, input.from, input.to));
  });
  app.post('/api/tags/delete', async (c) => {
    const input = parse(tagDeleteSchema, await jsonBody(c));
    return c.json(deleteTagPath(ctx.db, input.path));
  });
  app.post('/api/tags/delete-many', async (c) => c.json(deleteTagPaths(ctx.db, parse(tagDeleteManySchema, await jsonBody(c)).paths)));
  app.post('/api/tags/move', async (c) => {
    const input = parse(tagMoveSchema, await jsonBody(c));
    return c.json(moveTagPaths(ctx.db, input.paths, input.parent));
  });
  app.post('/api/tags/merge', async (c) => {
    const input = parse(tagMergeSchema, await jsonBody(c));
    return c.json(mergeTagPaths(ctx.db, input.from, input.to));
  });
  app.get('/api/dict/manage', (c) => c.json(getDictManage(ctx.db)));

  // ------------------------------------------------------------ 学生与作答记录（与题目内容版本无关）
  app.get('/api/students', (c) => c.json(listStudents(ctx.db, { includeArchived: c.req.query('all') === '1' })));
  app.post('/api/students', async (c) => {
    const input = parse(studentCreateSchema, await jsonBody(c));
    const r = createStudent(ctx.db, input);
    return c.json(r.student, r.created ? 201 : 200);
  });
  app.get('/api/students/:id', (c) => c.json(getStudentDetail(ctx.db, uuidParam(c))));
  app.put('/api/students/:id', async (c) => {
    const input = parse(studentUpdateSchema, await jsonBody(c));
    return c.json(updateStudent(ctx.db, uuidParam(c), input));
  });
  app.post('/api/students/:id/archive', (c) => c.json(setStudentArchived(ctx.db, uuidParam(c), true)));
  app.post('/api/students/:id/unarchive', (c) => c.json(setStudentArchived(ctx.db, uuidParam(c), false)));
  app.get('/api/attempts', (c) => {
    const q = c.req.query();
    const num = q.limit && /^\d+$/.test(q.limit) ? Number(q.limit) : undefined;
    return c.json(
      listAttempts(ctx.db, {
        studentId: q.studentId && isUuid(q.studentId) ? q.studentId.toLowerCase() : undefined,
        problemId: q.problemId && isUuid(q.problemId) ? q.problemId.toLowerCase() : undefined,
        limit: num,
      }),
    );
  });
  app.post('/api/attempts', async (c) => {
    const input = parse(attemptCreateSchema, await jsonBody(c));
    const r = createAttempt(ctx.db, input);
    return c.json(r.attempt, r.created ? 201 : 200);
  });
  app.post('/api/attempts/batch', async (c) => {
    const input = parse(attemptBatchSchema, await jsonBody(c));
    return c.json(createAttemptsBatch(ctx.db, input));
  });
  app.put('/api/attempts/:id', async (c) => {
    const input = parse(attemptUpdateSchema, await jsonBody(c));
    return c.json(updateAttempt(ctx.db, uuidParam(c), input));
  });
  app.post('/api/attempts/:id/delete', (c) => {
    setAttemptDeleted(ctx.db, uuidParam(c), true);
    return c.json({ ok: true });
  });
  app.post('/api/attempts/:id/restore', (c) => {
    setAttemptDeleted(ctx.db, uuidParam(c), false);
    return c.json({ ok: true });
  });

  // ------------------------------------------------------------ 自定义属性（定义与选项）
  app.get('/api/properties', (c) => c.json(listPropertyDefs(ctx.db, { includeArchived: c.req.query('all') === '1' })));
  app.post('/api/properties', async (c) => {
    const input = parse(propertyCreateSchema, await jsonBody(c));
    return c.json(createPropertyDef(ctx.db, input), 201);
  });
  app.post('/api/properties/reorder', async (c) => {
    const input = parse(idListSchema, await jsonBody(c));
    reorderPropertyDefs(ctx.db, input.ids);
    return c.json(listPropertyDefs(ctx.db, { includeArchived: true }));
  });
  app.get('/api/properties/:id', (c) => c.json(getPropertyDef(ctx.db, uuidParam(c))));
  app.put('/api/properties/:id', async (c) => {
    const input = parse(propertyUpdateSchema, await jsonBody(c));
    return c.json(updatePropertyDef(ctx.db, uuidParam(c), input, makeToucher(ctx.db)));
  });
  app.post('/api/properties/:id/archive', (c) => c.json(setPropertyArchived(ctx.db, uuidParam(c), true, makeToucher(ctx.db))));
  app.post('/api/properties/:id/unarchive', (c) => c.json(setPropertyArchived(ctx.db, uuidParam(c), false, makeToucher(ctx.db))));
  app.post('/api/properties/:id/options', async (c) => {
    const input = parse(optionCreateSchema, await jsonBody(c));
    return c.json(createOption(ctx.db, uuidParam(c), input), 201);
  });
  app.post('/api/properties/:id/options/ensure-path', async (c) => {
    const input = parse(optionPathSchema, await jsonBody(c));
    const id = uuidParam(c);
    const optionId = ensureOptionPath(ctx.db, id, input.path);
    return c.json({ optionId, property: getPropertyDef(ctx.db, id) });
  });
  app.post('/api/properties/:id/import', async (c) => {
    const input = parse(outlineImportSchema, await jsonBody(c));
    return c.json(importOutline(ctx.db, uuidParam(c), input.outline));
  });
  app.put('/api/property-options/:id', async (c) => {
    const input = parse(optionUpdateSchema, await jsonBody(c));
    return c.json(renameOption(ctx.db, uuidParam(c), input.label, makeToucher(ctx.db)));
  });
  app.post('/api/property-options/:id/move', async (c) => {
    const input = parse(optionMoveSchema, await jsonBody(c));
    return c.json(moveOption(ctx.db, uuidParam(c), input.parentId, input.index, makeToucher(ctx.db)));
  });
  app.post('/api/property-options/:id/merge', async (c) => {
    const input = parse(optionMergeSchema, await jsonBody(c));
    return c.json(mergeOption(ctx.db, uuidParam(c), input.intoId, makeToucher(ctx.db)));
  });
  app.post('/api/property-options/:id/delete', (c) => c.json(deleteOption(ctx.db, uuidParam(c), makeToucher(ctx.db))));
  app.post('/api/property-options/delete-many', async (c) => {
    const input = parse(idListSchema, await jsonBody(c));
    return c.json(deleteOptions(ctx.db, input.ids, makeToucher(ctx.db)));
  });
  app.post('/api/property-options/merge-many', async (c) => {
    const input = parse(optionMergeManySchema, await jsonBody(c));
    return c.json(mergeOptions(ctx.db, input.ids, input.intoId, makeToucher(ctx.db)));
  });
  app.post('/api/property-options/move-many', async (c) => {
    const input = parse(optionMoveManySchema, await jsonBody(c));
    return c.json(moveOptions(ctx.db, input.ids, input.parentId, input.index, makeToucher(ctx.db)));
  });
  app.post('/api/dict/:kind/add', async (c) => {
    const input = parse(dictValueSchema, await jsonBody(c));
    addDictEntry(ctx.db, c.req.param('kind'), input.value);
    return c.json(getDictManage(ctx.db));
  });
  app.post('/api/dict/:kind/rename', async (c) => {
    const input = parse(dictRenameSchema, await jsonBody(c));
    return c.json(renameDictValue(ctx.db, c.req.param('kind'), input.from, input.to));
  });
  app.post('/api/dict/:kind/reorder', async (c) => {
    const input = parse(dictReorderSchema, await jsonBody(c));
    reorderDict(ctx.db, c.req.param('kind'), input.values);
    return c.json(getDictManage(ctx.db));
  });
  app.post('/api/dict/:kind/remove', async (c) => {
    const input = parse(dictValueSchema, await jsonBody(c));
    removeDictEntry(ctx.db, c.req.param('kind'), input.value);
    return c.json(getDictManage(ctx.db));
  });
  app.post('/api/dict/:kind/remove-many', async (c) => {
    removeDictEntries(ctx.db, c.req.param('kind'), parse(dictValuesSchema, await jsonBody(c)).values);
    return c.json(getDictManage(ctx.db));
  });
  app.post('/api/dict/:kind/merge', async (c) => {
    const input = parse(dictMergeSchema, await jsonBody(c));
    return c.json(mergeDictValues(ctx.db, c.req.param('kind'), input.values, input.into));
  });

  // ------------------------------------------------------------ 题目
  app.get('/api/problems', listRoute(ctx, 'problem'));
  app.post('/api/problems/batch', async (c) => {
    const input = parse(batchSchema, await jsonBody(c));
    return c.json(runBatch(ctx.db, 'problem', input.ids, input.action));
  });
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
  app.get('/api/materials', listRoute(ctx, 'material'));
  app.post('/api/materials/batch', async (c) => {
    const input = parse(batchSchema, await jsonBody(c));
    return c.json(runBatch(ctx.db, 'material', input.ids, input.action));
  });
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
