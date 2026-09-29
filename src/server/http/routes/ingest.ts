/** 收录：上传图片与文本文件、粘贴文字、远程图片归档。 */
import { rawTextInputSchema, remoteImageCreateSchema } from '../../../shared/api.js';
import { getRemoteImage, ingestImage, ingestRemoteImageUrl, ingestText, ingestTextFile } from '../../services/ingest.js';
import { body, fileFromForm, uuidParam, type RegisterRoutes } from '../helpers.js';

export const register: RegisterRoutes = (app, ctx) => {
  app.post('/api/uploads/image', async (c) => {
    const f = await fileFromForm(c);
    return c.json(await ingestImage(ctx, f.data, f.name, f.blockId), 201);
  });
  app.post('/api/uploads/text-file', async (c) => {
    const f = await fileFromForm(c);
    return c.json(await ingestTextFile(ctx, f.data, f.name ?? 'untitled.txt', f.blockId), 201);
  });
  app.post('/api/raw-inputs/text', async (c) => {
    const input = await body(c, rawTextInputSchema);
    return c.json(ingestText(ctx, input.text, input.blockId ?? null), 201);
  });
  app.post('/api/remote-images', async (c) => {
    const input = await body(c, remoteImageCreateSchema);
    return c.json(await ingestRemoteImageUrl(ctx, input.url, input.blockId ?? null), 201);
  });
  app.get('/api/remote-images/:id', (c) => c.json(getRemoteImage(ctx, uuidParam(c))));
  app.post('/api/remote-images/:id/retry', async (c) => c.json(await ctx.archiver.archive(uuidParam(c))));
  app.post('/api/remote-images/:id/manual', async (c) => {
    const id = uuidParam(c);
    const f = await fileFromForm(c);
    return c.json(await ctx.archiver.manualUpload(id, f.data, f.name));
  });
};
