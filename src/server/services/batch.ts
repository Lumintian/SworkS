/**
 * 批量操作：对多道题目或多份资料做同一个字段级修改。
 * - 整批在一个事务内完成；有 ID 不存在时整批失败，不做部分修改。
 * - 只有真正变化的对象才递增 write_version、刷新 updated_at 并重建检索投影；
 *   这样仍打开着的旧编辑页保存时会得到 409，而不会把旧标签/旧学科写回。
 * - 回收站中的对象跳过（恢复操作除外）。
 */
import type { BatchAction, BatchResultDTO } from '../../shared/api.js';
import { nowIso, type DB } from '../db/connection.js';
import { AppError } from '../errors.js';
import { getEntityRow, resolveTagIds, setDeletedTx } from './entities.js';
import { bumpVersion } from './versioning.js';
import { applyPropertyOp, optionIndex, type OptionIndex } from './properties.js';
import { normalizeShortText, ownerColumn, ownerTable, placeholders, tagTable, type EntityRow, type OwnerKind } from './rows.js';
import { reindex } from './search.js';

export function runBatch(db: DB, kind: OwnerKind, ids: readonly string[], action: BatchAction): BatchResultDTO {
  if (action.op === 'setStatus' && kind !== 'material') throw new AppError('VALIDATION', '只有资料有整理状态');
  const unique = [...new Set(ids.map((i) => i.toLowerCase()))];
  return db.transaction((): BatchResultDTO => {
    const rows = new Map<string, EntityRow>();
    for (const id of unique) {
      const row = getEntityRow(db, kind, id);
      if (!row) throw new AppError('NOT_FOUND', `${kind === 'problem' ? '题目' : '资料'}不存在：${id}`);
      rows.set(id, row);
    }
    const now = nowIso();
    const changed: string[] = [];
    let unchanged = 0;
    let skipped = 0;
    const result: BatchResultDTO = { changed, unchanged: 0, skipped: 0 };

    if (action.op === 'trash' || action.op === 'restore') {
      for (const id of unique) {
        if (setDeletedTx(db, kind, id, action.op === 'trash').changed) changed.push(id);
        else unchanged++;
      }
      return { changed, unchanged, skipped };
    }

    const live = unique.filter((id) => {
      if (rows.get(id)!.deleted_at === null) return true;
      skipped++;
      return false;
    });
    const table = ownerTable(kind);
    const col = ownerColumn(kind);
    // 批量操作不改选项树：整批共用一份选项路径表，不必每个对象都重读
    let idx: OptionIndex | undefined;
    const touch = (id: string, reindexNeeded: boolean) => {
      bumpVersion(db, kind, id, now);
      if (reindexNeeded) reindex(db, kind, id, (idx ??= optionIndex(db)));
      changed.push(id);
    };

    switch (action.op) {
      case 'addTags': {
        const tagIds = resolveTagIds(db, action.names);
        result.tagIds = tagIds;
        const has = db.prepare(`SELECT 1 FROM ${tagTable(kind)} WHERE ${col} = ? AND tag_id = ?`);
        const add = db.prepare(`INSERT INTO ${tagTable(kind)} (${col}, tag_id) VALUES (?, ?)`);
        for (const id of live) {
          let did = false;
          for (const tagId of tagIds) {
            if (has.get(id, tagId)) continue;
            add.run(id, tagId);
            did = true;
          }
          if (did) touch(id, true);
          else unchanged++;
        }
        break;
      }
      case 'removeTags': {
        const tagIds = [...new Set(action.tagIds.map((t) => t.toLowerCase()))];
        const del = db.prepare(
          `DELETE FROM ${tagTable(kind)} WHERE ${col} = ? AND tag_id IN (${placeholders(tagIds.length)})`,
        );
        for (const id of live) {
          if (del.run(id, ...tagIds).changes > 0) touch(id, true);
          else unchanged++;
        }
        break;
      }
      case 'setSubject':
      case 'setStage': {
        const column = action.op === 'setSubject' ? 'subject' : 'stage';
        const value = normalizeShortText(action.value);
        const set = db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
        for (const id of live) {
          if (rows.get(id)![column] === value) {
            unchanged++;
            continue;
          }
          set.run(value, id);
          // 学科/学段不进入检索投影
          touch(id, false);
        }
        break;
      }
      case 'setProperty':
      case 'addOptions':
      case 'removeOptions': {
        const op =
          action.op === 'setProperty'
            ? { kind: 'set' as const, propertyId: action.propertyId, value: action.value }
            : { kind: action.op === 'addOptions' ? ('add' as const) : ('remove' as const), propertyId: action.propertyId, optionIds: action.optionIds };
        if (action.op === 'setProperty' && action.value && action.value.propertyId.toLowerCase() !== action.propertyId.toLowerCase()) {
          throw new AppError('VALIDATION', '属性 ID 不一致');
        }
        for (const id of live) {
          if (applyPropertyOp(db, { kind, id }, op)) touch(id, true);
          else unchanged++;
        }
        break;
      }
      case 'setStatus': {
        const set = db.prepare(`UPDATE ${table} SET status = ? WHERE id = ?`);
        for (const id of live) {
          if (rows.get(id)!.status === action.status) {
            unchanged++;
            continue;
          }
          set.run(action.status, id);
          touch(id, false);
        }
        break;
      }
    }
    result.unchanged = unchanged;
    result.skipped = skipped;
    return result;
  })();
}
