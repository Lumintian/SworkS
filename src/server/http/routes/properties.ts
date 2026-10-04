/** 自定义属性（定义与选项）。 */
import {
  idListSchema,
  optionCreateSchema,
  optionMergeManySchema,
  optionMergeSchema,
  optionMoveManySchema,
  optionMoveSchema,
  optionPathSchema,
  optionUpdateSchema,
  outlineImportSchema,
  propertyCreateSchema,
  propertyTypeChangeSchema,
  propertyUpdateSchema,
} from '../../../shared/api.js';
import {
  changePropertyType,
  createOption,
  createPropertyDef,
  deleteOption,
  deleteOptions,
  ensureOptionPath,
  getPropertyDef,
  importOutline,
  listPropertyDefs,
  mergeOption,
  optionUsage,
  propertyUsage,
  mergeOptions,
  moveOption,
  moveOptions,
  renameOption,
  reorderPropertyDefs,
  setPropertyArchived,
  updatePropertyDef,
} from '../../services/properties.js';
import { makeToucher } from '../../services/touch.js';
import { body, uuidParam, type RegisterRoutes } from '../helpers.js';

export const register: RegisterRoutes = (app, ctx) => {
  const { db } = ctx;
  app.get('/api/properties', (c) => c.json(listPropertyDefs(db, { includeArchived: c.req.query('all') === '1' })));
  app.post('/api/properties', async (c) => c.json(createPropertyDef(db, await body(c, propertyCreateSchema)), 201));
  app.get('/api/properties/usage', (c) => c.json(propertyUsage(db)));
  app.post('/api/properties/reorder', async (c) => {
    reorderPropertyDefs(db, (await body(c, idListSchema)).ids);
    return c.json(listPropertyDefs(db, { includeArchived: true }));
  });
  app.get('/api/properties/:id', (c) => c.json(getPropertyDef(db, uuidParam(c))));
  app.get('/api/properties/:id/usage', (c) => c.json(optionUsage(db, uuidParam(c))));
  app.put('/api/properties/:id', async (c) => {
    const input = await body(c, propertyUpdateSchema);
    return c.json(updatePropertyDef(db, uuidParam(c), input, makeToucher(db)));
  });
  app.post('/api/properties/:id/type', async (c) => {
    const input = await body(c, propertyTypeChangeSchema);
    return c.json(changePropertyType(db, uuidParam(c), input.type, makeToucher(db), { dryRun: input.dryRun }));
  });
  app.post('/api/properties/:id/archive', (c) => c.json(setPropertyArchived(db, uuidParam(c), true, makeToucher(db))));
  app.post('/api/properties/:id/unarchive', (c) => c.json(setPropertyArchived(db, uuidParam(c), false, makeToucher(db))));
  app.post('/api/properties/:id/options', async (c) => {
    const input = await body(c, optionCreateSchema);
    return c.json(createOption(db, uuidParam(c), input), 201);
  });
  app.post('/api/properties/:id/options/ensure-path', async (c) => {
    const input = await body(c, optionPathSchema);
    const id = uuidParam(c);
    const optionId = ensureOptionPath(db, id, input.path);
    return c.json({ optionId, property: getPropertyDef(db, id) });
  });
  app.post('/api/properties/:id/import', async (c) => {
    const input = await body(c, outlineImportSchema);
    return c.json(importOutline(db, uuidParam(c), input.outline, { dryRun: input.dryRun, nest: input.nest }));
  });

  // 多选的批量操作（静态路径，先于 /:id 注册）
  app.post('/api/property-options/delete-many', async (c) => c.json(deleteOptions(db, (await body(c, idListSchema)).ids, makeToucher(db))));
  app.post('/api/property-options/merge-many', async (c) => {
    const input = await body(c, optionMergeManySchema);
    return c.json(mergeOptions(db, input.ids, input.intoId, makeToucher(db)));
  });
  app.post('/api/property-options/move-many', async (c) => {
    const input = await body(c, optionMoveManySchema);
    return c.json(moveOptions(db, input.ids, input.parentId, input.index, makeToucher(db)));
  });
  app.put('/api/property-options/:id', async (c) => {
    const input = await body(c, optionUpdateSchema);
    return c.json(renameOption(db, uuidParam(c), input.label, makeToucher(db)));
  });
  app.post('/api/property-options/:id/move', async (c) => {
    const input = await body(c, optionMoveSchema);
    return c.json(moveOption(db, uuidParam(c), input.parentId, input.index, makeToucher(db)));
  });
  app.post('/api/property-options/:id/merge', async (c) => {
    const input = await body(c, optionMergeSchema);
    return c.json(mergeOption(db, uuidParam(c), input.intoId, makeToucher(db)));
  });
  app.post('/api/property-options/:id/delete', (c) => c.json(deleteOption(db, uuidParam(c), makeToucher(db))));
};
