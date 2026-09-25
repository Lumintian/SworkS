import fs from 'node:fs';
import yauzl from 'yauzl';
import yazl from 'yazl';

export interface RawEntry {
  name: string;
  data: Buffer;
}

export async function readZip(file: string): Promise<RawEntry[]> {
  const zip = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (e, z) => (e ? rej(e) : res(z))),
  );
  const out: RawEntry[] = [];
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith('/')) return zip.readEntry();
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          out.push({ name: entry.fileName, data: Buffer.concat(chunks) });
          zip.readEntry();
        });
        stream.on('error', reject);
      });
    });
    zip.on('end', () => resolve());
    zip.on('error', reject);
    zip.readEntry();
  });
  zip.close();
  return out;
}

export async function writeRawZip(
  file: string,
  entries: { name: string; data: Buffer; mode?: number }[],
): Promise<void> {
  const zip = new yazl.ZipFile();
  for (const e of entries) zip.addBuffer(e.data, e.name, { compress: false, ...(e.mode ? { mode: e.mode } : {}) });
  zip.end();
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(file);
    zip.outputStream.pipe(out).on('close', () => resolve()).on('error', reject);
  });
}

/** 重新打包：transform 返回 null 表示删除该条目。 */
export async function rezip(
  src: string,
  dest: string,
  transform: (e: RawEntry) => Buffer | null = (e) => e.data,
  extra: { name: string; data: Buffer; mode?: number }[] = [],
): Promise<void> {
  const entries = await readZip(src);
  const next: { name: string; data: Buffer; mode?: number }[] = [];
  for (const e of entries) {
    const data = transform(e);
    if (data) next.push({ name: e.name, data });
  }
  await writeRawZip(dest, [...next, ...extra]);
}

/** yazl 拒绝写出 “..” 路径；先用同长度占位名写出，再在二进制中替换，以构造越界路径条目。 */
export async function zipWithTraversalEntry(src: string, dest: string): Promise<void> {
  const placeholder = 'zz/evil.txt';
  const evil = '../evil.txt';
  await rezip(src, dest, (e) => e.data, [{ name: placeholder, data: Buffer.from('pwned') }]);
  const buf = fs.readFileSync(dest);
  const from = Buffer.from(placeholder);
  const to = Buffer.from(evil);
  let idx = buf.indexOf(from);
  while (idx !== -1) {
    to.copy(buf, idx);
    idx = buf.indexOf(from, idx + 1);
  }
  fs.writeFileSync(dest, buf);
}
