/**
 * 外部输入的统一入口：剪贴板/本地图片、粘贴文字、图片 URL、单个 .md/.txt 文件。
 * 每次输入都记录 RawInput（原文、原文件、原 URL 与采集时间），之后的编辑不会覆盖它。
 */
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AssetDTO, RemoteImageCreateDTO, RemoteImageDTO, TextFileImportDTO, UploadResultDTO } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import { nowIso, type DB } from '../db/connection.js';
import { AppError, toAppError } from '../errors.js';
import { toAssetDTO, type AssetRow } from './assetStore.js';
import { ensureRemoteImages } from './entities.js';
import { INPUT_ONLY_IMAGE_MIMES, IMAGE_FORMAT_LABELS, type ImageMime } from '../../shared/constants.js';
import { prepareForStorage } from './imageConvert.js';
import { SNIFF_BYTES, sniffImageInput, SUPPORTED_IMAGE_HINT } from './imageSniff.js';
import { getImagePolicy } from './settings.js';
import { missingLocalImages, remoteImageUrls } from './markdown.js';
import { downloadImage, parseRemoteUrl } from './remoteFetch.js';
import { toRemoteImageDTO, type RemoteImageRow } from './rows.js';

function insertRawInput(
  db: DB,
  r: {
    kind: 'text' | 'file' | 'url';
    text?: string | null;
    assetId?: string | null;
    url?: string | null;
    originalFilename?: string | null;
    blockId?: string | null;
    /** 收录时转换过格式：原文件的格式、大小与哈希（原字节不保留） */
    original?: { mime: string; size: number; sha256: string } | null;
  },
): string {
  const id = randomUUID();
  const o = r.original ?? null;
  db.prepare(
    `INSERT INTO raw_inputs (id, kind, text, asset_id, url, original_filename, problem_id, material_id, block_id, captured_at, original_mime, original_size, original_sha256)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(id, r.kind, r.text ?? null, r.assetId ?? null, r.url ?? null, r.originalFilename ?? null, r.blockId ?? null, nowIso(), o?.mime ?? null, o?.size ?? null, o?.sha256 ?? null);
  return id;
}

/**
 * 保存一张图片（剪贴板或本地文件）：按文件头识别格式，按图片策略转换（见 imageConvert），
 * 原始输入记录原文件的格式、大小与哈希。
 */
export async function ingestImage(
  ctx: AppContext,
  data: Uint8Array,
  originalFilename: string | null,
  blockId: string | null,
): Promise<UploadResultDTO> {
  if (data.byteLength === 0) throw new AppError('VALIDATION', '文件为空');
  if (data.byteLength > ctx.limits.maxImageBytes) {
    throw new AppError('TOO_LARGE', `图片超过 ${Math.round(ctx.limits.maxImageBytes / 1024 / 1024)} MiB 上限`);
  }
  const mime = sniffImageInput(data.subarray(0, SNIFF_BYTES));
  if (!mime) throw new AppError('UNSUPPORTED_MEDIA', `不支持的图片格式。${SUPPORTED_IMAGE_HINT}；文件未保存。`);
  const prepared = await prepareForStorage(data, mime, getImagePolicy(ctx.db));
  if (prepared.warning) ctx.log.warn(prepared.warning);
  const file = await ctx.store.putBuffer(prepared.data, prepared.mime);
  return ctx.db.transaction((): UploadResultDTO => {
    const asset = ctx.store.insertRow(file, originalFilename);
    const rawInputId = insertRawInput(ctx.db, {
      kind: 'file',
      assetId: asset.id,
      originalFilename: asset.original_filename,
      blockId,
      original: prepared.original,
    });
    return {
      asset: toAssetDTO(asset),
      rawInputId,
      ...(prepared.original
        ? { conversion: { from: IMAGE_FORMAT_LABELS[prepared.original.mime], to: IMAGE_FORMAT_LABELS[prepared.mime], originalSize: prepared.original.size, storedSize: prepared.data.byteLength } }
        : {}),
    };
  })();
}

/** 记录一次粘贴的原始文本。 */
export function ingestText(ctx: AppContext, text: string, blockId: string | null): { rawInputId: string } {
  return ctx.db.transaction(() => ({ rawInputId: insertRawInput(ctx.db, { kind: 'text', text, blockId }) }))();
}

function looksLikeText(data: Uint8Array): boolean {
  const sample = data.subarray(0, 8192);
  for (const byte of sample) if (byte === 0) return false;
  return true;
}

/** 导入单个 .md/.txt 文件到当前题目或资料：保留原始字节，不扫描其所在目录，不读取其引用的本地图片。 */
export async function ingestTextFile(
  ctx: AppContext,
  data: Uint8Array,
  originalFilename: string,
  blockId: string | null,
): Promise<TextFileImportDTO> {
  const ext = path.extname(originalFilename).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown' && ext !== '.txt') {
    throw new AppError('UNSUPPORTED_MEDIA', '只支持导入单个 .md 或 .txt 文件');
  }
  if (data.byteLength > ctx.limits.maxTextFileBytes) {
    throw new AppError('TOO_LARGE', `文本文件超过 ${Math.round(ctx.limits.maxTextFileBytes / 1024 / 1024)} MiB 上限`);
  }
  if (!looksLikeText(data)) throw new AppError('UNSUPPORTED_MEDIA', '文件内容不是文本');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new AppError('UNSUPPORTED_MEDIA', '文件不是 UTF-8 编码的文本，未导入。请转换为 UTF-8 后重试。');
  }
  const kind = ext === '.txt' ? 'text' : 'markdown';
  const mime = kind === 'text' ? 'text/plain' : 'text/markdown';
  const file = await ctx.store.putBuffer(data, mime);
  const result = ctx.db.transaction(() => {
    const asset = ctx.store.insertRow(file, originalFilename);
    const rawInputId = insertRawInput(ctx.db, {
      kind: 'file',
      assetId: asset.id,
      text,
      originalFilename: asset.original_filename,
      blockId,
    });
    return { asset: toAssetDTO(asset), rawInputId };
  })();
  return {
    ...result,
    text,
    kind,
    missingLocalImages: kind === 'markdown' ? missingLocalImages(text) : [],
    remoteImageUrls: kind === 'markdown' ? remoteImageUrls(text) : [],
  };
}

function getRemoteRow(db: DB, id: string): RemoteImageRow | undefined {
  return db.prepare('SELECT * FROM remote_images WHERE id = ?').get(id) as RemoteImageRow | undefined;
}

/**
 * 远程图片归档器：记录 URL → 下载并校验 → 保存本地 Asset → 标记已归档。
 * 失败时保留 URL、失败原因，支持重试或手动补传。网络与文件 IO 不在数据库事务内进行。
 */
export class RemoteArchiver {
  private readonly inflight = new Map<string, Promise<RemoteImageDTO>>();
  private readonly queue: string[] = [];
  private active = 0;
  private readonly concurrency = 2;
  private stopped = false;

  constructor(private readonly ctx: AppContext) {}

  enqueue(id: string): void {
    if (this.stopped || this.inflight.has(id) || this.queue.includes(id)) return;
    this.queue.push(id);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.active < this.concurrency && this.queue.length > 0) {
      const id = this.queue.shift()!;
      this.active++;
      this.archive(id)
        .catch(() => undefined)
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  /** 启动时继续处理上次未完成的待归档记录。 */
  resumePending(): void {
    const rows = this.ctx.db.prepare("SELECT id FROM remote_images WHERE status = 'pending'").all() as { id: string }[];
    for (const r of rows) this.enqueue(r.id);
  }

  archive(id: string): Promise<RemoteImageDTO> {
    const running = this.inflight.get(id);
    if (running) return running;
    const p = this.doArchive(id).finally(() => this.inflight.delete(id));
    this.inflight.set(id, p);
    return p;
  }

  private async doArchive(id: string): Promise<RemoteImageDTO> {
    const { db, store } = this.ctx;
    const row = getRemoteRow(db, id);
    if (!row) throw new AppError('NOT_FOUND', '远程图片记录不存在');
    if (row.status === 'archived') return toRemoteImageDTO(row);
    db.prepare("UPDATE remote_images SET status = 'pending', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(
      nowIso(),
      id,
    );
    const tmp = store.newTempPath('download');
    try {
      await fsp.mkdir(this.ctx.paths.tmp, { recursive: true });
      const result = await downloadImage(row.url, this.ctx.fetchPolicy, tmp);
      // 远程图片逐字节保存（URL 本身就是来源凭据）；只有浏览器无法显示的 HEIC/AVIF 转换成 WebP
      const file = (INPUT_ONLY_IMAGE_MIMES as readonly string[]).includes(result.mime)
        ? await (async () => {
            const prepared = await prepareForStorage(await fsp.readFile(tmp), result.mime, getImagePolicy(db), { convertStorable: false });
            return store.putBuffer(prepared.data, prepared.mime);
          })()
        : await store.commitTemp(tmp, { ...result, mime: result.mime as ImageMime });
      db.transaction(() => {
        const name = safeNameFromUrl(result.finalUrl);
        const asset = store.insertRow(file, name);
        db.prepare(
          `UPDATE remote_images SET status = 'archived', asset_id = ?, archived_via = 'download',
             error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`,
        ).run(asset.id, nowIso(), id);
      })();
    } catch (err) {
      const e = toAppError(err);
      try {
        db.prepare(
          "UPDATE remote_images SET status = 'failed', error_code = ?, error_message = ?, updated_at = ? WHERE id = ? AND status <> 'archived'",
        ).run(e.code, e.message, nowIso(), id);
      } catch {
        // 数据库不可写时保持 pending，下次启动继续
      }
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
    return toRemoteImageDTO(getRemoteRow(db, id)!);
  }

  /** 失败后手动补传一张本地图片作为该 URL 的归档副本。 */
  async manualUpload(id: string, data: Uint8Array, originalFilename: string | null): Promise<RemoteImageDTO> {
    const { db } = this.ctx;
    const row = getRemoteRow(db, id);
    if (!row) throw new AppError('NOT_FOUND', '远程图片记录不存在');
    const uploaded = await ingestImage(this.ctx, data, originalFilename, null);
    db.transaction(() => {
      db.prepare(
        `UPDATE remote_images SET status = 'archived', asset_id = ?, archived_via = 'manual',
           error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ?`,
      ).run(uploaded.asset.id, nowIso(), id);
      db.prepare('UPDATE raw_inputs SET url = ? WHERE id = ?').run(row.url, uploaded.rawInputId);
    })();
    return toRemoteImageDTO(getRemoteRow(db, id)!);
  }

  async idle(): Promise<void> {
    while (this.inflight.size > 0 || this.queue.length > 0) {
      await Promise.allSettled([...this.inflight.values()]);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
  }
}

function safeNameFromUrl(url: string): string | null {
  try {
    const base = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    return base.slice(0, 120) || null;
  } catch {
    return null;
  }
}

/**
 * 用户输入一个图片 URL：记录原始 URL，立即尝试下载归档。
 * 即使下载失败，记录也会保存，并明确标记“图片尚未归档”。
 */
export async function ingestRemoteImageUrl(
  ctx: AppContext,
  rawUrl: string,
  blockId: string | null,
): Promise<RemoteImageCreateDTO> {
  const trimmed = rawUrl.trim();
  parseRemoteUrl(trimmed);
  const { id, rawInputId } = ctx.db.transaction(() => {
    ensureRemoteImages(ctx.db, [trimmed]);
    const row = ctx.db.prepare('SELECT id FROM remote_images WHERE url = ?').get(trimmed) as { id: string };
    return { id: row.id, rawInputId: insertRawInput(ctx.db, { kind: 'url', url: trimmed, blockId }) };
  })();
  const remote = await ctx.archiver.archive(id);
  let asset: AssetDTO | null = null;
  if (remote.assetId) {
    const row = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(remote.assetId) as AssetRow | undefined;
    asset = row ? toAssetDTO(row) : null;
  }
  return { remoteImage: remote, asset, rawInputId };
}

export function getRemoteImage(ctx: AppContext, id: string): RemoteImageDTO {
  const row = getRemoteRow(ctx.db, id);
  if (!row) throw new AppError('NOT_FOUND', '远程图片记录不存在');
  return toRemoteImageDTO(row);
}
