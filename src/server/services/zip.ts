/** yazl / yauzl 的 Promise 封装与安全检查；不自行实现 ZIP 格式。 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { AppError } from '../errors.js';
import { fsyncFile } from '../fsutil.js';

export type ZipItem =
  | { name: string; buffer: Buffer; compress?: boolean }
  | { name: string; file: string; compress?: boolean };

const FIXED_MTIME = new Date('2000-01-01T00:00:00Z');

/** 写出 ZIP 到 target（调用方负责之后原子发布）。 */
export async function writeZip(target: string, items: ZipItem[]): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const item of items) {
    const opts = { compress: item.compress ?? true, mtime: FIXED_MTIME, mode: 0o100644 };
    if ('buffer' in item) zip.addBuffer(item.buffer, item.name, opts);
    else zip.addFile(item.file, item.name, opts);
  }
  zip.end();
  await pipeline(zip.outputStream as unknown as NodeJS.ReadableStream, fs.createWriteStream(target, { flags: 'wx' }));
  await fsyncFile(target);
}

export interface OpenedZip {
  zip: yauzl.ZipFile;
  entries: Map<string, yauzl.Entry>;
  close: () => void;
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

/**
 * 打开 ZIP 并读取目录。拒绝：越界/绝对路径（yauzl strictFileNames）、符号链接、加密条目、
 * 重复条目、不在白名单内的条目、超量条目与超量解压体积。
 */
export async function openZipChecked(
  file: string,
  opts: { maxEntries: number; maxTotalBytes: number; isAllowedName: (name: string) => boolean },
): Promise<OpenedZip> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(
      file,
      { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true, decodeStrings: true },
      (err, z) => (err ? reject(new AppError('BACKUP_INVALID', `备份文件不是有效的 ZIP：${err.message}`)) : resolve(z)),
    );
  });
  const entries = new Map<string, yauzl.Entry>();
  let total = 0;
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', (err: Error) => reject(new AppError('BACKUP_INVALID', `备份文件损坏或包含非法路径：${err.message}`)));
      zip.on('end', () => resolve());
      zip.on('entry', (entry: yauzl.Entry) => {
        try {
          const name = entry.fileName;
          const mode = (entry.externalFileAttributes >>> 16) & S_IFMT;
          if (mode === S_IFLNK) throw new AppError('BACKUP_INVALID', `备份中包含符号链接，已拒绝：${name}`);
          if (entry.isEncrypted()) throw new AppError('BACKUP_INVALID', `备份中包含加密条目，已拒绝：${name}`);
          if (name.endsWith('/') || mode === S_IFDIR) {
            if (!opts.isAllowedName(name)) throw new AppError('BACKUP_INVALID', `备份中包含未知目录：${name}`);
          } else {
            if (!opts.isAllowedName(name)) throw new AppError('BACKUP_INVALID', `备份中包含未知或越界路径：${name}`);
            if (entries.has(name)) throw new AppError('BACKUP_INVALID', `备份中存在重复条目：${name}`);
            entries.set(name, entry);
            total += entry.uncompressedSize;
            if (total > opts.maxTotalBytes) throw new AppError('BACKUP_INVALID', '备份解压后体积超过上限，已拒绝');
          }
          if (entries.size > opts.maxEntries) throw new AppError('BACKUP_INVALID', '备份条目数量超过上限，已拒绝');
          zip.readEntry();
        } catch (err) {
          reject(err);
        }
      });
      zip.readEntry();
    });
  } catch (err) {
    zip.close();
    throw err;
  }
  return { zip, entries, close: () => zip.close() };
}

function openEntryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) =>
      err ? reject(new AppError('BACKUP_INVALID', `无法读取备份条目 ${entry.fileName}：${err.message}`)) : resolve(stream),
    );
  });
}

/** 读取条目到内存（有大小上限）。 */
export async function readEntryBuffer(zip: yauzl.ZipFile, entry: yauzl.Entry, maxBytes: number): Promise<Buffer> {
  if (entry.uncompressedSize > maxBytes) throw new AppError('BACKUP_INVALID', `${entry.fileName} 过大`);
  const stream = await openEntryStream(zip, entry);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) throw new AppError('BACKUP_INVALID', `${entry.fileName} 过大`);
      chunks.push(chunk as Buffer);
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('BACKUP_INVALID', `备份条目 ${entry.fileName} 损坏：${(err as Error).message}`);
  }
  return Buffer.concat(chunks);
}

/** 流式计算条目哈希；给出 dest 时同时写出（并刷盘）。 */
export async function hashEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  dest?: string,
): Promise<{ sha256: string; size: number }> {
  const stream = await openEntryStream(zip, entry);
  const hash = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    if (dest) {
      await pipeline(stream, tap, fs.createWriteStream(dest, { flags: 'wx' }));
      await fsyncFile(dest);
    } else {
      await pipeline(stream, tap, async function* (source) {
        for await (const _ of source) {
          // 仅计算哈希
        }
      });
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code && ['EACCES', 'EROFS', 'ENOSPC', 'EPERM', 'EEXIST'].includes(code)) throw err;
    throw new AppError('BACKUP_INVALID', `备份条目 ${entry.fileName} 损坏：${(err as Error).message}`);
  }
  return { sha256: hash.digest('hex'), size };
}
