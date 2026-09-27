/** 管理操作改动了对象内容（或只影响其检索投影）后的收尾：按需递增版本，并重建检索投影。 */
import { nowIso, type DB } from '../db/connection.js';
import { bumpVersion } from './entities.js';
import type { Owner } from './rows.js';
import { reindex } from './search.js';
import type { TouchOwner } from './properties.js';

/** 同一次操作共用一个时间戳；同一对象只处理一次（需要递增时以递增为准）。 */
export function makeToucher(db: DB): TouchOwner {
  const now = nowIso();
  const done = new Map<string, boolean>();
  return (owner: Owner, bump: boolean) => {
    const key = `${owner.kind}:${owner.id}`;
    const prev = done.get(key);
    if (prev === true || (prev === false && !bump)) return;
    if (bump) bumpVersion(db, owner.kind, owner.id, now);
    reindex(db, owner.kind, owner.id);
    done.set(key, bump);
  };
}
