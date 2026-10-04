/** 撤销刚做的管理操作（删除或合并标签、选项，清除或合并学科学段…）。 */
import { applyUndo } from '../../services/undo.js';
import { uuidParam, type RegisterRoutes } from '../helpers.js';

export const register: RegisterRoutes = (app, ctx) => {
  app.post('/api/undo/:id', (c) => c.json(applyUndo(ctx.db, uuidParam(c))));
};
