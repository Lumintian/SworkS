import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MIME_EXTENSIONS, type AssetMime } from '../../shared/constants.js';
import type { AssetDTO } from '../../shared/api.js';
import { nowIso, type DB } from '../db/connection.js';
import { AppError, toAppError } from '../errors.js';
import { fsyncDir } from '../fsutil.js';
import type { DataPaths } from '../paths.js';

export interface AssetRow {
  id: string;
  sha256: string;
  rel_path: string;
  mime: AssetMime;
  size: number;
  original_filename: string | null;
  created_at: string;
}

export interface StoredFile {
  sha256: string;
  relPath: string;
  size: number;
  mime: AssetMime;
}

export const REL_PATH_RE = /^[0-9a-f]{2}\/[0-9a-f]{64}\.(png|jpg|webp|gif|md|txt)$/;

export function relPathFor(sha256: string, mime: AssetMime): string {
  return `${sha256.slice(0, 2)}/${sha256}.${MIME_EXTENSIONS[mime]}`;
}

export function toAssetDTO(row: AssetRow): AssetDTO {
  return {
    id: row.id,
    sha256: row.sha256,
    mime: row.mime,
    size: row.size,
    originalFilename: row.original_filename,
    createdAt: row.created_at,
  };
}

export function sanitizeOriginalFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  // 只保留文件名部分，去除控制字符；这是展示信息，不参与磁盘路径
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255);
  return cleaned || null;
}

/**
 * 附件存储：先写入临时文件并刷盘，再原子移入受控目录（按内容哈希命名），最后由调用方提交数据库引用。
 * 文件按哈希复用字节，但每次输入都会产生独立的 asset 记录，不合并题目/资料/来源记录。
 */
export class AssetStore {
  constructor(
    private readonly paths: DataPaths,
    private readonly db: DB,
  ) {}

  absolutePath(relPath: string): string {
    if (!REL_PATH_RE.test(relPath)) throw new AppError('VALIDATION', '非法附件路径');
    return path.join(this.paths.assets, relPath);
  }

  getRow(id: string): AssetRow | undefined {
    return this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
  }

  newTempPath(suffix: string): string {
    return path.join(this.paths.tmp, `${randomUUID()}.${suffix}`);
  }

  /** 将内存中的字节写入受控目录。 */
  async putBuffer(data: Uint8Array, mime: AssetMime): Promise<StoredFile> {
    const sha256 = createHash('sha256').update(data).digest('hex');
    const tmp = this.newTempPath('part');
    try {
      await fsp.mkdir(this.paths.tmp, { recursive: true });
      const handle = await fsp.open(tmp, 'wx');
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      return await this.commitTemp(tmp, { sha256, size: data.byteLength, mime });
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw toAppError(err);
    }
  }

  /** 把已经写好并刷盘的临时文件发布到受控目录。 */
  async commitTemp(tmp: string, info: { sha256: string; size: number; mime: AssetMime }): Promise<StoredFile> {
    const relPath = relPathFor(info.sha256, info.mime);
    const target = this.absolutePath(relPath);
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      let reuse = false;
      try {
        const st = await fsp.stat(target);
        reuse = st.isFile() && st.size === info.size && (await sha256File(target)) === info.sha256;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (reuse) {
        await fsp.rm(tmp, { force: true });
      } else {
        await fsp.rename(tmp, target);
        await fsyncDir(path.dirname(target));
      }
      return { sha256: info.sha256, relPath, size: info.size, mime: info.mime };
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw toAppError(err);
    }
  }

  /** 提交数据库引用；应在事务中调用。 */
  insertRow(file: StoredFile, originalFilename: string | null): AssetRow {
    const row: AssetRow = {
      id: randomUUID(),
      sha256: file.sha256,
      rel_path: file.relPath,
      mime: file.mime,
      size: file.size,
      original_filename: sanitizeOriginalFilename(originalFilename),
      created_at: nowIso(),
    };
    this.db
      .prepare(
        'INSERT INTO assets (id, sha256, rel_path, mime, size, original_filename, created_at) VALUES (@id, @sha256, @rel_path, @mime, @size, @original_filename, @created_at)',
      )
      .run(row);
    return row;
  }

  openRead(row: AssetRow): fs.ReadStream {
    return fs.createReadStream(this.absolutePath(row.rel_path));
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = fs.createReadStream(file);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
