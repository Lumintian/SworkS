/** 分类管理：标签（按路径）与学科/学段字典。 */
import {
  idListSchema,
  dictMergeSchema,
  dictRenameSchema,
  dictReorderSchema,
  dictValueSchema,
  dictValuesSchema,
  tagDeleteManySchema,
  tagDeleteSchema,
  tagMergeSchema,
  tagMoveSchema,
  tagRenameSchema,
} from '../../../shared/api.js';
import { getDictionary, listTags } from '../../services/catalog.js';
import {
  addDictEntry,
  deleteTagPath,
  deleteUnusedTags,
  deleteTagPaths,
  getDictManage,
  getTagManage,
  mergeDictValues,
  mergeTagPaths,
  moveTagPaths,
  removeDictEntries,
  removeDictEntry,
  renameDictValue,
  renameTagPath,
  reorderDict,
} from '../../services/taxonomy.js';
import { body, type RegisterRoutes } from '../helpers.js';

export const register: RegisterRoutes = (app, ctx) => {
  const { db } = ctx;
  app.get('/api/tags', (c) => c.json(listTags(db, { all: c.req.query('all') === '1' })));
  app.get('/api/tags/manage', (c) => c.json(getTagManage(db)));
  app.post('/api/tags/delete-unused', async (c) => c.json(deleteUnusedTags(db, (await body(c, idListSchema)).ids)));
  app.post('/api/tags/rename', async (c) => {
    const input = await body(c, tagRenameSchema);
    return c.json(renameTagPath(db, input.from, input.to));
  });
  app.post('/api/tags/delete', async (c) => c.json(deleteTagPath(db, (await body(c, tagDeleteSchema)).path)));
  app.post('/api/tags/delete-many', async (c) => c.json(deleteTagPaths(db, (await body(c, tagDeleteManySchema)).paths)));
  app.post('/api/tags/move', async (c) => {
    const input = await body(c, tagMoveSchema);
    return c.json(moveTagPaths(db, input.paths, input.parent));
  });
  app.post('/api/tags/merge', async (c) => {
    const input = await body(c, tagMergeSchema);
    return c.json(mergeTagPaths(db, input.from, input.to));
  });

  app.get('/api/dict', (c) => c.json(getDictionary(db)));
  app.get('/api/dict/manage', (c) => c.json(getDictManage(db)));
  app.post('/api/dict/:kind/add', async (c) => {
    addDictEntry(db, c.req.param('kind'), (await body(c, dictValueSchema)).value);
    return c.json(getDictManage(db));
  });
  app.post('/api/dict/:kind/rename', async (c) => {
    const input = await body(c, dictRenameSchema);
    return c.json(renameDictValue(db, c.req.param('kind'), input.from, input.to));
  });
  app.post('/api/dict/:kind/reorder', async (c) => {
    reorderDict(db, c.req.param('kind'), (await body(c, dictReorderSchema)).values);
    return c.json(getDictManage(db));
  });
  app.post('/api/dict/:kind/remove', async (c) => {
    removeDictEntry(db, c.req.param('kind'), (await body(c, dictValueSchema)).value);
    return c.json(getDictManage(db));
  });
  app.post('/api/dict/:kind/remove-many', async (c) => {
    removeDictEntries(db, c.req.param('kind'), (await body(c, dictValuesSchema)).values);
    return c.json(getDictManage(db));
  });
  app.post('/api/dict/:kind/merge', async (c) => {
    const input = await body(c, dictMergeSchema);
    return c.json(mergeDictValues(db, c.req.param('kind'), input.values, input.into));
  });
};
