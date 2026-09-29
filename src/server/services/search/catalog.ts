/** 服务端的查询目录：属性（含已归档，保存的检索可能引用它们）、选项路径与学生。 */
import type { QueryCatalog } from '../../../shared/query/resolve.js';
import type { DB } from '../../db/connection.js';
import { listPropertyDefs } from '../properties.js';

export function serverCatalog(db: DB): QueryCatalog {
  return {
    properties: listPropertyDefs(db, { includeArchived: true }).map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      nested: d.nested,
      appliesProblem: d.appliesProblem,
      appliesMaterial: d.appliesMaterial,
      archived: d.archived,
      options: d.options.map((o) => ({ id: o.id, parentId: o.parentId, path: o.path })),
    })),
    students: db.prepare('SELECT id, name FROM students ORDER BY created_at, id').all() as { id: string; name: string }[],
  };
}
