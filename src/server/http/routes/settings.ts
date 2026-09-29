/** 库级设置：图片存储策略。 */
import { imagePolicySchema } from '../../../shared/api.js';
import { getImagePolicy, setImagePolicy } from '../../services/settings.js';
import { body, type RegisterRoutes } from '../helpers.js';

export const register: RegisterRoutes = (app, ctx) => {
  app.get('/api/settings/images', (c) => c.json(getImagePolicy(ctx.db)));
  app.put('/api/settings/images', async (c) => c.json(setImagePolicy(ctx.db, await body(c, imagePolicySchema.partial()))));
};
