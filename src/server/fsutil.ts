import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 刷盘目录项，保证 rename 等目录操作持久化。部分平台不支持对目录 fsync，忽略该类错误。 */
export async function fsyncDir(dir: string): Promise<void> {
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(dir, 'r');
    await handle.sync();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EISDIR' && code !== 'EINVAL' && code !== 'EPERM' && code !== 'EBADF') throw err;
  } finally {
    await handle?.close();
  }
}

export async function fsyncFile(file: string): Promise<void> {
  const handle = await fsp.open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 写入临时文件 → fsync → 原子 rename 到目标。mode 为新文件权限（例如 0o600 只允许本人读写）。 */
export async function writeFileAtomic(target: string, data: string | Uint8Array, tmpDir: string, mode = 0o666): Promise<void> {
  await fsp.mkdir(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fsp.open(tmp, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, target);
  await fsyncDir(path.dirname(target));
}

export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function dirIsEmptyOrMissing(dir: string): boolean {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return false;
    return fs.readdirSync(dir).length === 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw err;
  }
}

export function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
}
