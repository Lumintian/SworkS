/** 附件：把题图交给模型识别。 */
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { openAsset } from '../services/assets.js';
import { createBackup } from '../services/backup.js';
import { MAX_INPUT_PIXELS } from '../services/imageConvert.js';
import { defineOp } from './registry.js';

/** 操作返回的图片（MCP 里转成 image 内容） */
export interface OpImage {
  type: 'image';
  /** base64 */
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

export function isOpImage(v: unknown): v is OpImage {
  return typeof v === 'object' && v !== null && (v as { type?: unknown }).type === 'image' && typeof (v as { data?: unknown }).data === 'string';
}

export const assetOps = [
  defineOp({
    name: 'get_asset_image',
    title: '读取题图',
    description: '按附件 ID 读取图片（题干里的图片块、Markdown 中的 assets/<ID>.<ext>），缩小到长边不超过 maxEdge 像素后返回，供识别题目内容、公式与图形。',
    input: z
      .object({
        id: z.uuid().transform((v) => v.toLowerCase()),
        maxEdge: z.number().int().min(64).max(4096).default(1568),
      })
      .strict(),
    access: 'read',
    run: async (ctx, input): Promise<OpImage> => {
      const { row, file } = openAsset(ctx, input.id);
      if (!row.mime.startsWith('image/')) throw new AppError('UNSUPPORTED_MEDIA', '这个附件不是图片');
      const bytes = await fs.readFile(file);
      // 动图只取第一帧；统一输出 PNG（无损，模型都能读）
      const out = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS })
        .rotate()
        .resize({ width: input.maxEdge, height: input.maxEdge, fit: 'inside', withoutEnlargement: true })
        .png()
        .toBuffer({ resolveWithObject: true });
      return { type: 'image', data: out.data.toString('base64'), mimeType: 'image/png', width: out.info.width, height: out.info.height };
    },
  }),
  defineOp({
    name: 'create_backup',
    title: '完整备份',
    description: '立即做一次完整备份（与“备份与导出”页相同，写到数据目录的 backups/ 下）。不改动题库内容。',
    input: z.object({}).strict(),
    access: 'write',
    run: async (ctx) => {
      const r = await createBackup(ctx);
      return { fileName: r.fileName, size: r.size, createdAt: r.createdAt };
    },
  }),
];
