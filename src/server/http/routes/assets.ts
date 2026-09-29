/** 附件读取：图片内联显示，其他类型只允许下载；一律沙箱化。 */
import { openAsset } from '../../services/assets.js';
import { fileResponse, uuidParam, type RegisterRoutes } from '../helpers.js';

export const register: RegisterRoutes = (app, ctx) => {
  app.get('/api/assets/:id', (c) => {
    const { row, file } = openAsset(ctx, uuidParam(c));
    const isImage = row.mime.startsWith('image/');
    return fileResponse(file, {
      'content-type': isImage ? row.mime : `${row.mime}; charset=utf-8`,
      'content-length': String(row.size),
      'cache-control': 'private, max-age=31536000, immutable',
      'content-security-policy': "default-src 'none'; sandbox",
      ...(isImage ? {} : { 'content-disposition': 'attachment' }),
    });
  });
};
