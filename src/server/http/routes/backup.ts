/** 备份与 Markdown 导出。 */
import fs from 'node:fs';
import { exportMarkdownSchema } from '../../../shared/api.js';
import { backupFilePath, createBackup, lastBackupAt, listBackups } from '../../services/backup.js';
import { exportProblemsMarkdown } from '../../services/exportMarkdown.js';
import { body, fileResponse, type RegisterRoutes } from '../helpers.js';

export const register: RegisterRoutes = (app, ctx) => {
  app.get('/api/backups', async (c) => c.json({ backups: await listBackups(ctx), lastBackupAt: lastBackupAt(ctx) }));
  app.post('/api/backups', async (c) => c.json(await createBackup(ctx), 201));
  app.get('/api/backups/:name', (c) => {
    const name = c.req.param('name');
    const file = backupFilePath(ctx, name);
    return fileResponse(file, {
      'content-type': 'application/zip',
      'content-length': String(fs.statSync(file).size),
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    });
  });
  app.post('/api/export/markdown', async (c) => {
    const input = await body(c, exportMarkdownSchema);
    const out = await exportProblemsMarkdown(ctx, input.problemIds);
    // 流式返回临时 zip，发送完（或连接中断）后删除
    return fileResponse(
      out.zipPath,
      {
        'content-type': 'application/zip',
        'content-length': String(fs.statSync(out.zipPath).size),
        'content-disposition': `attachment; filename="${out.fileName}"`,
        'x-sworks-export-warnings': String(out.warnings.length),
        'cache-control': 'no-store',
      },
      () => fs.rm(out.zipPath, { force: true }, () => {}),
    );
  });
};
