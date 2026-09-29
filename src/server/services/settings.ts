/** 库级设置（存在 library_meta 里，随备份）：目前只有图片存储策略。 */
import { DEFAULT_IMAGE_POLICY, imagePolicySchema, type ImagePolicyDTO } from '../../shared/api.js';
import type { DB } from '../db/connection.js';
import { getMeta, setMeta } from '../db/migrations.js';
import { AppError } from '../errors.js';

const IMAGE_POLICY_KEY = 'image_policy';

export function getImagePolicy(db: DB): ImagePolicyDTO {
  const raw = getMeta(db, IMAGE_POLICY_KEY);
  if (!raw) return { ...DEFAULT_IMAGE_POLICY };
  try {
    // 缺少的字段用默认值补上（以后新增字段时旧库照常可用）
    const r = imagePolicySchema.safeParse({ ...DEFAULT_IMAGE_POLICY, ...(JSON.parse(raw) as object) });
    return r.success ? r.data : { ...DEFAULT_IMAGE_POLICY };
  } catch {
    return { ...DEFAULT_IMAGE_POLICY };
  }
}

export function setImagePolicy(db: DB, patch: Partial<ImagePolicyDTO>): ImagePolicyDTO {
  const r = imagePolicySchema.safeParse({ ...getImagePolicy(db), ...patch });
  if (!r.success) throw new AppError('VALIDATION', `图片设置无效：${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message}`);
  setMeta(db, IMAGE_POLICY_KEY, JSON.stringify(r.data));
  return r.data;
}
