/** 读取附件：按 ID 找到记录与磁盘文件。 */
import fs from 'node:fs';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import type { AssetRow } from './assetStore.js';

export function openAsset(ctx: AppContext, id: string): { row: AssetRow; file: string } {
  const row = ctx.db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
  if (!row) throw new AppError('NOT_FOUND', '附件不存在');
  const file = ctx.store.absolutePath(row.rel_path);
  if (!fs.existsSync(file)) throw new AppError('NOT_FOUND', '附件文件缺失');
  return { row, file };
}
