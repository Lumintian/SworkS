/**
 * 管理操作的收尾（标签、字典、属性与选项的管理操作共用）。
 * 操作过程中只收集受影响的对象（add），finish() 在同一事务里统一处理：
 * - 内容变了的对象递增一次版本（同一操作里多次命中也只递增一次）；只是显示文字变了的只重建检索投影；
 * - 重建检索投影时共用一份选项路径表（逐个对象重读整张选项表，在大库里会让一次改名卡住好几秒）；
 * - 常用检索里被合并掉的选项改指向合并目标。
 * 先收集、最后统一处理：一个操作可能分几步改同一个对象（例如多个选项依次合并到同一目标），
 * 边改边重建会把中间状态留在检索投影里。
 */
import { nowIso, type DB } from '../db/connection.js';
import { optionIndex } from './properties.js';
import type { Owner } from './rows.js';
import { rewriteSavedSearches } from './savedSearches.js';
import { reindex } from './search.js';
import { bumpVersion, recordReindexOnly } from './versioning.js';

export interface Toucher {
  /** 记下受影响的对象：bump 为真表示内容变了（递增版本），否则只重建检索投影。同一对象以“需要递增”为准 */
  add(owner: Owner, bump: boolean): void;
  /** 选项 from 已合并到 into：常用检索里的条件跟着改指向 */
  optionMerged(from: string, into: string): void;
  /** 处理已收集的对象；应在操作的事务结束前调用，可以多次调用 */
  finish(): void;
  /** 到目前为止递增过版本的对象数 */
  readonly bumpedCount: number;
}

/** 同一次操作共用一个时间戳。 */
export function makeToucher(db: DB): Toucher {
  const now = nowIso();
  const pending = new Map<string, { owner: Owner; bump: boolean }>();
  const bumped = new Set<string>();
  const merged = new Map<string, string>();
  return {
    add(owner, bump) {
      const key = `${owner.kind}:${owner.id}`;
      pending.set(key, { owner, bump: bump || (pending.get(key)?.bump ?? false) });
    },
    optionMerged(from, into) {
      merged.set(from, into);
    },
    finish() {
      if (pending.size) {
        const idx = optionIndex(db);
        for (const [key, { owner, bump }] of pending) {
          if (bump && !bumped.has(key)) {
            bumpVersion(db, owner.kind, owner.id, now);
            bumped.add(key);
          } else if (!bump && !bumped.has(key)) {
            recordReindexOnly(db, owner.kind, owner.id);
          }
          reindex(db, owner.kind, owner.id, idx);
        }
        pending.clear();
      }
      if (merged.size) {
        // 合并可能连成链（下级先并入目标的同名下级，那个下级又被并入目标）：一直追到最终目标
        const target = (id: string) => {
          let x = id;
          for (let i = 0; i < 64 && merged.has(x); i++) x = merged.get(x)!;
          return x;
        };
        rewriteSavedSearches(db, (q) => {
          if (q.k !== 'prop' || q.test.t !== 'options' || !q.test.optionIds.some((id) => merged.has(id))) return q;
          return { ...q, test: { t: 'options', optionIds: [...new Set(q.test.optionIds.map(target))] } };
        });
        merged.clear();
      }
    },
    get bumpedCount() {
      return bumped.size;
    },
  };
}
