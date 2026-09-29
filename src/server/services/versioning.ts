/**
 * 题目/资料版本的唯一入口。凡是改变了对象内容的写入都经过这里：
 * 递增 write_version、刷新 updated_at，并记录一条变更（提交后发出事件）。
 * 这样仍打开着的旧编辑页保存时会得到 409，其他页面也能即时刷新。
 * 调用方负责在同一事务内 reindex。
 */
import { nowIso, type DB } from '../db/connection.js';
import { recordEntity } from '../events/changes.js';
import { ownerTable, type OwnerKind } from './rows.js';

export function bumpVersion(db: DB, kind: OwnerKind, id: string, now: string = nowIso()): void {
  db.prepare(`UPDATE ${ownerTable(kind)} SET updated_at = ?, write_version = write_version + 1 WHERE id = ?`).run(now, id);
  recordEntity(db, kind, id);
}

/** 新建对象（版本从 1 开始）。 */
export function recordCreated(db: DB, kind: OwnerKind, id: string): void {
  recordEntity(db, kind, id, 'created');
}

/** 只重建了检索投影、版本不变（例如选项改名、属性归档）。 */
export function recordReindexOnly(db: DB, kind: OwnerKind, id: string): void {
  recordEntity(db, kind, id, 'reindexOnly');
}
