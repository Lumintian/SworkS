/**
 * 完整备份交换格式（manifest.json + records.json + assets/ + README.txt）。
 * 详见 docs/backup-format.md。恢复与备份自检共用这里的校验逻辑。
 * 每个备份格式版本对应一个数据库 schema 版本与一组表；旧版本的表定义冻结不改，恢复时按版本校验。
 */
import { z } from 'zod';
import { APP_VERSION } from '../../shared/constants.js';
import type { Limits } from '../config.js';
import type { DB } from '../db/connection.js';
import { LATEST_SCHEMA_VERSION } from '../db/migrations.js';
import { AppError } from '../errors.js';
import { REL_PATH_RE, relPathFor } from './assetStore.js';
import { hashEntry, openZipChecked, readEntryBuffer, type OpenedZip } from './zip.js';
import { createHash } from 'node:crypto';

export const BACKUP_FORMAT = 'sworks-backup';
export const RECORDS_FORMAT = 'sworks-records';
export const BACKUP_SCHEMA_VERSION = 3;

const str = z.string();
const nstr = z.string().nullable();
const int = z.number().int();
const uuid = z.uuid();
const iso = z.string().min(10).max(40);
const niso = iso.nullable();

/** v1 的表（冻结）：按父表在前的顺序；search_index 为可重建投影，不备份。 */
export const RECORD_TABLES_V1 = {
  library_meta: z.object({ key: str, value: str }).strict(),
  dict_entries: z.object({ kind: z.enum(['subject', 'stage']), value: str, position: int }).strict(),
  assets: z
    .object({
      id: uuid,
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      rel_path: z.string().regex(REL_PATH_RE),
      mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'text/markdown', 'text/plain']),
      size: int.min(0),
      original_filename: nstr,
      created_at: iso,
    })
    .strict(),
  remote_images: z
    .object({
      id: uuid,
      url: str,
      status: z.enum(['pending', 'archived', 'failed']),
      asset_id: uuid.nullable(),
      archived_via: z.enum(['download', 'manual']).nullable(),
      error_code: nstr,
      error_message: nstr,
      attempts: int,
      created_at: iso,
      updated_at: iso,
    })
    .strict(),
  problems: z
    .object({
      id: uuid,
      title: nstr,
      subject: nstr,
      stage: nstr,
      source_note: nstr,
      created_at: iso,
      updated_at: iso,
      deleted_at: niso,
      write_version: int.min(1),
    })
    .strict(),
  materials: z
    .object({
      id: uuid,
      title: nstr,
      subject: nstr,
      stage: nstr,
      source_note: nstr,
      status: z.enum(['inbox', 'active']),
      created_at: iso,
      updated_at: iso,
      deleted_at: niso,
      write_version: int.min(1),
    })
    .strict(),
  content_blocks: z
    .object({
      id: uuid,
      problem_id: uuid.nullable(),
      material_id: uuid.nullable(),
      position: int,
      kind: z.enum(['markdown', 'text', 'image']),
      body: nstr,
      asset_id: uuid.nullable(),
      remote_image_id: uuid.nullable(),
      caption: nstr,
      created_at: iso,
      updated_at: iso,
    })
    .strict(),
  notes: z
    .object({
      id: uuid,
      problem_id: uuid,
      type: z.enum(['note', 'answer', 'solution']),
      title: nstr,
      body_md: str,
      position: int,
      created_at: iso,
      updated_at: iso,
      deleted_at: niso,
    })
    .strict(),
  tags: z.object({ id: uuid, name: str, created_at: iso }).strict(),
  problem_tags: z.object({ problem_id: uuid, tag_id: uuid }).strict(),
  material_tags: z.object({ material_id: uuid, tag_id: uuid }).strict(),
  problem_material_links: z
    .object({ problem_id: uuid, material_id: uuid, note: nstr, created_at: iso })
    .strict(),
  raw_inputs: z
    .object({
      id: uuid,
      kind: z.enum(['text', 'file', 'url']),
      text: nstr,
      asset_id: uuid.nullable(),
      url: nstr,
      original_filename: nstr,
      problem_id: uuid.nullable(),
      material_id: uuid.nullable(),
      block_id: nstr,
      captured_at: iso,
    })
    .strict(),
} as const;

const bool01 = z.union([z.literal(0), z.literal(1)]);

/** v2：v1 加上自定义属性（定义、选项树、取值）。 */
export const RECORD_TABLES_V2 = {
  ...RECORD_TABLES_V1,
  property_defs: z
    .object({
      id: uuid,
      name: str,
      type: z.enum(['text', 'number', 'date', 'checkbox', 'select', 'multiselect']),
      nested: bool01,
      applies_problem: bool01,
      applies_material: bool01,
      preset: nstr,
      position: int,
      show_in_nav: bool01,
      created_at: iso,
      updated_at: iso,
      archived_at: niso,
    })
    .strict(),
  property_options: z
    .object({
      id: uuid,
      property_id: uuid,
      parent_id: uuid.nullable(),
      label: str,
      position: int,
      created_at: iso,
      updated_at: iso,
      deleted_at: niso,
    })
    .strict(),
  property_values: z
    .object({
      problem_id: uuid.nullable(),
      material_id: uuid.nullable(),
      property_id: uuid,
      option_id: uuid.nullable(),
      text_value: nstr,
      number_value: z.number().nullable(),
    })
    .strict(),
} as const;

/** v3：v2 加上学生与作答记录。 */
export const RECORD_TABLES_V3 = {
  ...RECORD_TABLES_V2,
  students: z
    .object({
      id: uuid,
      name: str,
      stage: nstr,
      note: nstr,
      created_at: iso,
      updated_at: iso,
      archived_at: niso,
      write_version: int.min(1),
    })
    .strict(),
  student_attempts: z
    .object({
      id: uuid,
      student_id: uuid,
      problem_id: uuid,
      attempted_at: iso,
      result: z.enum(['correct', 'partial', 'wrong', 'blank']),
      felt_difficulty: int.min(1).max(5).nullable(),
      duration_sec: int.min(0).nullable(),
      note: nstr,
      created_at: iso,
      updated_at: iso,
      deleted_at: niso,
    })
    .strict(),
} as const;

/** 当前版本写出的表。 */
export const RECORD_TABLES = RECORD_TABLES_V3;

type TableSchemas = Record<string, z.ZodType>;

/** 备份格式版本 → 对应的数据库 schema 版本与表集合。只增不改。 */
export const BACKUP_VERSIONS: Record<number, { dbSchemaVersion: number; tables: TableSchemas }> = {
  1: { dbSchemaVersion: 1, tables: RECORD_TABLES_V1 },
  2: { dbSchemaVersion: 2, tables: RECORD_TABLES_V2 },
  3: { dbSchemaVersion: 3, tables: RECORD_TABLES_V3 },
};

export type RecordTable = keyof typeof RECORD_TABLES;
export const TABLE_ORDER = Object.keys(RECORD_TABLES) as RecordTable[];

/** 某个备份格式版本的表顺序（父表在前）。 */
export function tableOrderFor(backupSchemaVersion: number): string[] {
  const v = BACKUP_VERSIONS[backupSchemaVersion];
  if (!v) throw new AppError('BACKUP_UNSUPPORTED', `不支持的备份格式版本 v${backupSchemaVersion}`);
  return Object.keys(v.tables);
}

const ORDER_BY: Record<RecordTable, string> = {
  library_meta: 'key',
  dict_entries: 'kind, position, value',
  assets: 'created_at, id',
  remote_images: 'created_at, id',
  problems: 'created_at, id',
  materials: 'created_at, id',
  content_blocks: 'created_at, id',
  notes: 'created_at, id',
  tags: 'created_at, id',
  problem_tags: 'problem_id, tag_id',
  material_tags: 'material_id, tag_id',
  problem_material_links: 'problem_id, material_id',
  raw_inputs: 'captured_at, id',
  property_defs: 'position, id',
  property_options: 'property_id, created_at, id',
  property_values: 'property_id, problem_id, material_id, option_id, text_value, number_value',
  students: 'created_at, id',
  student_attempts: 'attempted_at, id',
};

/**
 * 记录内容。旧版本备份里不存在的表在校验后为空数组，
 * 真正要写入与核对的表以 tableOrderFor(backupSchemaVersion) 为准。
 */
export type Records = { [K in RecordTable]: z.infer<(typeof RECORD_TABLES)[K]>[] };

export interface RecordsFile {
  format: typeof RECORDS_FORMAT;
  backupSchemaVersion: number;
  dbSchemaVersion: number;
  tables: Records;
}

export function exportRecords(db: DB): RecordsFile {
  const tables = {} as Records;
  for (const t of TABLE_ORDER) {
    (tables as Record<string, unknown[]>)[t] = db.prepare(`SELECT * FROM ${t} ORDER BY ${ORDER_BY[t]}`).all();
  }
  // 运行状态信息不属于库内容
  tables.library_meta = tables.library_meta.filter((r) => !r.key.startsWith('last_backup'));
  return {
    format: RECORDS_FORMAT,
    backupSchemaVersion: BACKUP_SCHEMA_VERSION,
    dbSchemaVersion: db.pragma('user_version', { simple: true }) as number,
    tables,
  };
}

const assetEntrySchema = z
  .object({ path: z.string().regex(/^assets\/[0-9a-f]{64}$/), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: int.min(0) })
  .strict();

export const manifestSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    backupSchemaVersion: int.min(1),
    appVersion: str,
    dbSchemaVersion: int.min(1),
    libraryId: str,
    createdAt: iso,
    counts: z.record(z.string(), int.min(0)),
    records: z.object({ path: z.literal('records.json'), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: int.min(0) }).strict(),
    assets: z.array(assetEntrySchema),
    assetTotalBytes: int.min(0),
    remoteImages: z
      .object({
        total: int.min(0),
        archived: int.min(0),
        unarchived: z.array(z.object({ url: str, status: z.enum(['pending', 'failed']), errorMessage: nstr }).strict()),
      })
      .strict(),
    integrity: z.object({ localDataComplete: z.boolean(), allRemoteImagesArchived: z.boolean() }).strict(),
  })
  .strict();
export type Manifest = z.infer<typeof manifestSchema>;

export function isAllowedBackupEntry(name: string): boolean {
  return (
    name === 'manifest.json' ||
    name === 'records.json' ||
    name === 'README.txt' ||
    name === 'assets/' ||
    /^assets\/[0-9a-f]{64}$/.test(name)
  );
}

export function buildManifest(records: RecordsFile, recordsSha: string, recordsSize: number, assets: Manifest['assets']): Manifest {
  const counts: Record<string, number> = {};
  for (const t of TABLE_ORDER) counts[t] = records.tables[t].length;
  const remote = records.tables.remote_images;
  const unarchived = remote
    .filter((r) => r.status !== 'archived')
    .map((r) => ({ url: r.url, status: r.status as 'pending' | 'failed', errorMessage: r.error_message }));
  return {
    format: BACKUP_FORMAT,
    backupSchemaVersion: BACKUP_SCHEMA_VERSION,
    appVersion: APP_VERSION,
    dbSchemaVersion: records.dbSchemaVersion,
    libraryId: records.tables.library_meta.find((m) => m.key === 'library_id')?.value ?? 'unknown',
    createdAt: new Date().toISOString(),
    counts,
    records: { path: 'records.json', sha256: recordsSha, size: recordsSize },
    assets,
    assetTotalBytes: assets.reduce((s, a) => s + a.size, 0),
    remoteImages: { total: remote.length, archived: remote.length - unarchived.length, unarchived },
    integrity: { localDataComplete: true, allRemoteImagesArchived: unarchived.length === 0 },
  };
}

export interface ValidatedBackup {
  opened: OpenedZip;
  manifest: Manifest;
  records: RecordsFile;
}

/**
 * 校验备份包：格式、版本、路径、数量/体积、records 校验和、记录结构与数量、
 * 附件清单与记录一致性。assetSink 不为空时逐个校验附件哈希并交给调用方写出。
 */
export async function validateBackup(
  file: string,
  limits: Pick<Limits, 'maxRestoreBytes' | 'maxRestoreEntries' | 'maxRecordsBytes'>,
  assetSink?: (sha256: string) => string | null,
): Promise<ValidatedBackup> {
  const opened = await openZipChecked(file, {
    maxEntries: limits.maxRestoreEntries,
    maxTotalBytes: limits.maxRestoreBytes,
    isAllowedName: isAllowedBackupEntry,
  });
  try {
    const { zip, entries } = opened;
    const manifestEntry = entries.get('manifest.json');
    if (!manifestEntry) throw new AppError('BACKUP_INVALID', '备份缺少 manifest.json');
    let manifestRaw: unknown;
    try {
      manifestRaw = JSON.parse((await readEntryBuffer(zip, manifestEntry, 256 * 1024 * 1024)).toString('utf8'));
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('BACKUP_INVALID', 'manifest.json 已损坏（不是有效 JSON）');
    }
    const head = z.object({ format: z.string(), backupSchemaVersion: z.number(), dbSchemaVersion: z.number() }).safeParse(manifestRaw);
    if (!head.success || head.data.format !== BACKUP_FORMAT) {
      throw new AppError('BACKUP_INVALID', '不是 SworkS 备份文件（manifest 格式标识不符）');
    }
    if (head.data.backupSchemaVersion > BACKUP_SCHEMA_VERSION || head.data.dbSchemaVersion > LATEST_SCHEMA_VERSION) {
      throw new AppError(
        'BACKUP_UNSUPPORTED',
        `备份格式版本 v${head.data.backupSchemaVersion}（数据库 v${head.data.dbSchemaVersion}）高于本程序支持的 v${BACKUP_SCHEMA_VERSION}（数据库 v${LATEST_SCHEMA_VERSION}），拒绝恢复。请使用更新版本的 SworkS。`,
      );
    }
    const known = BACKUP_VERSIONS[head.data.backupSchemaVersion];
    if (!known || known.dbSchemaVersion !== head.data.dbSchemaVersion) {
      throw new AppError(
        'BACKUP_UNSUPPORTED',
        `不支持的备份版本 v${head.data.backupSchemaVersion}（数据库 v${head.data.dbSchemaVersion}），当前没有对应的迁移链。`,
      );
    }
    const parsed = manifestSchema.safeParse(manifestRaw);
    if (!parsed.success) throw new AppError('BACKUP_INVALID', `manifest.json 结构无效：${parsed.error.issues[0]?.message ?? ''}`);
    const manifest = parsed.data;

    // records.json
    const recordsEntry = entries.get('records.json');
    if (!recordsEntry) throw new AppError('BACKUP_INVALID', '备份缺少 records.json');
    if (recordsEntry.uncompressedSize !== manifest.records.size) throw new AppError('BACKUP_INVALID', 'records.json 大小与清单不符');
    const recordsBuf = await readEntryBuffer(zip, recordsEntry, limits.maxRecordsBytes);
    const recordsSha = createHash('sha256').update(recordsBuf).digest('hex');
    if (recordsSha !== manifest.records.sha256) throw new AppError('BACKUP_INVALID', 'records.json 校验和不符，备份可能被篡改或损坏');
    let recordsRaw: unknown;
    try {
      recordsRaw = JSON.parse(recordsBuf.toString('utf8'));
    } catch {
      throw new AppError('BACKUP_INVALID', 'records.json 不是有效 JSON');
    }
    const records = validateRecords(recordsRaw, manifest);

    // 附件清单 ↔ ZIP 条目 ↔ 记录
    const listed = new Map(manifest.assets.map((a) => [a.path, a]));
    if (listed.size !== manifest.assets.length) throw new AppError('BACKUP_INVALID', '附件清单存在重复条目');
    for (const a of manifest.assets) {
      if (a.path !== `assets/${a.sha256}`) throw new AppError('BACKUP_INVALID', `附件路径与哈希不一致：${a.path}`);
      const entry = entries.get(a.path);
      if (!entry) throw new AppError('BACKUP_INVALID', `备份缺少附件文件：${a.path}`);
      if (entry.uncompressedSize !== a.size) throw new AppError('BACKUP_INVALID', `附件大小与清单不符：${a.path}`);
    }
    for (const name of entries.keys()) {
      if (name.startsWith('assets/') && !listed.has(name)) throw new AppError('BACKUP_INVALID', `备份包含清单外的附件：${name}`);
    }
    const neededShas = new Set(records.tables.assets.map((a) => a.sha256));
    for (const sha of neededShas) {
      if (!listed.has(`assets/${sha}`)) throw new AppError('BACKUP_INVALID', `记录引用的附件不在备份中：${sha}`);
    }
    for (const a of records.tables.assets) {
      if (a.rel_path !== relPathFor(a.sha256, a.mime)) throw new AppError('BACKUP_INVALID', `附件记录路径不一致：${a.id}`);
      const listedAsset = listed.get(`assets/${a.sha256}`)!;
      if (listedAsset.size !== a.size) throw new AppError('BACKUP_INVALID', `附件记录大小与清单不符：${a.id}`);
    }
    for (const a of manifest.assets) {
      const dest = assetSink ? assetSink(a.sha256) : null;
      const got = await hashEntry(zip, entries.get(a.path)!, dest ?? undefined);
      if (got.sha256 !== a.sha256 || got.size !== a.size) {
        throw new AppError('BACKUP_INVALID', `附件校验失败（哈希不符）：${a.path}，备份可能被篡改或损坏`);
      }
    }
    return { opened, manifest, records };
  } catch (err) {
    opened.close();
    throw err;
  }
}

function validateRecords(raw: unknown, manifest: Manifest): RecordsFile {
  const head = z
    .object({
      format: z.literal(RECORDS_FORMAT),
      backupSchemaVersion: z.literal(manifest.backupSchemaVersion),
      dbSchemaVersion: z.literal(manifest.dbSchemaVersion),
      tables: z.record(z.string(), z.array(z.unknown())),
    })
    .strict()
    .safeParse(raw);
  if (!head.success) throw new AppError('BACKUP_INVALID', 'records.json 结构无效或与清单版本不一致');
  const schemas = BACKUP_VERSIONS[manifest.backupSchemaVersion]!.tables;
  const tables = Object.fromEntries(TABLE_ORDER.map((t) => [t, []])) as unknown as Records;
  for (const name of Object.keys(head.data.tables)) {
    if (!(name in schemas)) throw new AppError('BACKUP_INVALID', `records.json 包含未知表：${name}`);
  }
  for (const t of Object.keys(schemas)) {
    const rows = head.data.tables[t];
    if (!rows) throw new AppError('BACKUP_INVALID', `records.json 缺少表：${t}`);
    const schema = schemas[t]!;
    const out: unknown[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = schema.safeParse(rows[i]);
      if (!r.success) {
        throw new AppError('BACKUP_INVALID', `records.json 中 ${t} 第 ${i + 1} 行无效：${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
      }
      out.push(r.data);
    }
    if (manifest.counts[t] !== out.length) throw new AppError('BACKUP_INVALID', `${t} 记录数量与清单不符`);
    (tables as Record<string, unknown[]>)[t] = out;
  }
  return {
    format: RECORDS_FORMAT,
    backupSchemaVersion: manifest.backupSchemaVersion,
    dbSchemaVersion: manifest.dbSchemaVersion,
    tables,
  };
}

export const BACKUP_README = `SworkS 完整备份
================

这是 SworkS 的完整备份包，用于恢复与迁移，包含个人笔记、来源 URL 与学生的作答记录，不是公开分享包。

内容：
- manifest.json   格式标识、版本、库 ID、记录与附件数量、校验信息、未归档远程图片摘要
- records.json    全部逻辑记录（题目、资料、内容块、笔记、标签、自定义属性与考点、来源、原始输入、
                  学生与作答记录、回收站状态等）
- assets/<sha256> 所有附件的原始字节（按内容哈希命名，类型见 records.json 中 assets 表）

恢复（需先停止 SworkS 服务，并恢复到一个新的空目录）：

  pnpm restore -- --input <本文件> --data-dir <新的空目录>

注意：未成功归档的远程图片无法通过备份补回，备份只保留其 URL 与状态。
`;
