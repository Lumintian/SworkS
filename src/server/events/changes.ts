/**
 * 变更记录：服务层在写事务内调用 record*()，把“什么变了”写进连接私有的临时表 `sworks_changes`。
 * - 事务回滚时这些行一起消失，所以失败的写入不会发出事件；
 * - 事务提交后由 setImmediate 统一取出：按来源分组、查出对象当前版本，再发到事件总线。
 * 没有安装变更记录的连接（恢复、迁移、命令行工具）调用 record*() 不做任何事。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DB } from '../db/connection.js';
import type { OwnerKind } from '../services/rows.js';
import type { EventBus } from './bus.js';
import type { CatalogPart, EntityRef, Origin } from './types.js';

export type { Origin } from './types.js';

/** 当前请求/任务的来源；中间件与后台任务用 originStore.run() 设置。 */
export const originStore = new AsyncLocalStorage<Origin>();

const DEFAULT_ORIGIN: Origin = { kind: 'system', source: 'startup' };

export function currentOrigin(): Origin {
  return originStore.getStore() ?? DEFAULT_ORIGIN;
}

/** entity 行的 flag */
const CHANGED = 0;
const CREATED = 1;
const REINDEX_ONLY = 2;

type RecordKind = 'entity' | 'catalog' | 'attempt' | 'rawInput' | 'remoteImage';

interface ChangeRow {
  kind: RecordKind;
  a: string | null;
  b: string | null;
  flag: number;
  origin: string;
}

class ChangeLog {
  private scheduled = false;
  private readonly insert;

  constructor(
    private readonly db: DB,
    private readonly bus: EventBus,
  ) {
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS sworks_changes (
      seq INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      a TEXT,
      b TEXT,
      flag INTEGER NOT NULL DEFAULT 0,
      origin TEXT NOT NULL
    )`);
    this.insert = db.prepare('INSERT INTO temp.sworks_changes (kind, a, b, flag, origin) VALUES (?, ?, ?, ?, ?)');
  }

  record(kind: RecordKind, a: string | null, b: string | null, flag = 0): void {
    this.insert.run(kind, a, b, flag, JSON.stringify(currentOrigin()));
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      try {
        this.flush();
      } catch {
        // 连接已关闭等：丢弃本批事件，不影响写入
      }
    });
  }

  /** 取出并清空已提交的变更，按来源分组发出事件。 */
  flush(): void {
    const { db } = this;
    if (!db.open) return;
    if (db.inTransaction) {
      this.schedule();
      return;
    }
    const rows = db.transaction(() => {
      const r = db.prepare('SELECT kind, a, b, flag, origin FROM temp.sworks_changes ORDER BY seq').all() as ChangeRow[];
      db.prepare('DELETE FROM temp.sworks_changes').run();
      return r;
    })();
    if (rows.length === 0) return;
    const groups = new Map<string, ChangeRow[]>();
    for (const r of rows) {
      const g = groups.get(r.origin);
      if (g) g.push(r);
      else groups.set(r.origin, [r]);
    }
    for (const [originJson, group] of groups) this.emitGroup(JSON.parse(originJson) as Origin, group);
  }

  private emitGroup(origin: Origin, rows: ChangeRow[]): void {
    const flags = { problem: new Map<string, number[]>(), material: new Map<string, number[]>() };
    const parts = new Set<CatalogPart>();
    const students = new Set<string>();
    const attemptProblems = new Set<string>();
    const rawIds: string[] = [];
    const assetIds = new Set<string>();
    const remoteIds = new Set<string>();
    for (const r of rows) {
      switch (r.kind) {
        case 'entity': {
          const m = flags[r.a as OwnerKind];
          const id = r.b!;
          const f = m.get(id);
          if (f) f.push(r.flag);
          else m.set(id, [r.flag]);
          break;
        }
        case 'catalog':
          parts.add(r.a as CatalogPart);
          break;
        case 'attempt':
          if (r.a) students.add(r.a);
          if (r.b) attemptProblems.add(r.b);
          break;
        case 'rawInput':
          rawIds.push(r.a!);
          if (r.b) assetIds.add(r.b);
          break;
        case 'remoteImage':
          remoteIds.add(r.a!);
          break;
      }
    }
    if (flags.problem.size || flags.material.size) {
      const created: string[] = [];
      const reindexOnly: string[] = [];
      const refs = (kind: OwnerKind): EntityRef[] => {
        const m = flags[kind];
        if (m.size === 0) return [];
        const table = kind === 'problem' ? 'problems' : 'materials';
        const current = this.db
          .prepare(`SELECT id, write_version, deleted_at FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`)
          .all(JSON.stringify([...m.keys()])) as { id: string; write_version: number; deleted_at: string | null }[];
        for (const [id, fs] of m) {
          if (fs.includes(CREATED)) created.push(id);
          if (fs.every((f) => f === REINDEX_ONLY)) reindexOnly.push(id);
        }
        return current.map((r) => ({ id: r.id, version: r.write_version, deleted: r.deleted_at !== null }));
      };
      const problems = refs('problem');
      const materials = refs('material');
      this.bus.emit('entities.changed', { problems, materials, created, reindexOnly, origin });
    }
    if (parts.size) this.bus.emit('catalog.changed', { parts: [...parts], origin });
    if (students.size || attemptProblems.size) {
      this.bus.emit('attempts.changed', { studentIds: [...students], problemIds: [...attemptProblems], origin });
    }
    if (rawIds.length) this.bus.emit('rawInputs.created', { ids: rawIds, assetIds: [...assetIds], origin });
    if (remoteIds.size) this.bus.emit('remoteImages.changed', { ids: [...remoteIds], origin });
  }
}

const logs = new WeakMap<DB, ChangeLog>();

/** 为服务进程的数据库连接安装变更记录（每个连接一次）。 */
export function installChangeLog(db: DB, bus: EventBus): void {
  if (!logs.has(db)) logs.set(db, new ChangeLog(db, bus));
}

/** 立即取出并发出已提交的变更（测试与关闭前用）。 */
export function flushChanges(db: DB): void {
  logs.get(db)?.flush();
}

/** 题目/资料的内容变化（已递增版本）。 */
export function recordEntity(db: DB, kind: OwnerKind, id: string, how: 'changed' | 'created' | 'reindexOnly' = 'changed'): void {
  logs.get(db)?.record('entity', kind, id, how === 'created' ? CREATED : how === 'reindexOnly' ? REINDEX_ONLY : CHANGED);
}

/** 标签、字典、属性、常用检索或学生名单变化。 */
export function recordCatalog(db: DB, part: CatalogPart): void {
  logs.get(db)?.record('catalog', part, null);
}

/** 作答记录变化（不影响题目版本）。 */
export function recordAttempt(db: DB, studentId: string | null, problemId: string | null): void {
  logs.get(db)?.record('attempt', studentId, problemId);
}

export function recordRawInput(db: DB, rawInputId: string, assetId: string | null): void {
  logs.get(db)?.record('rawInput', rawInputId, assetId);
}

export function recordRemoteImage(db: DB, id: string): void {
  logs.get(db)?.record('remoteImage', id, null);
}
