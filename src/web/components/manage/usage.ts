/** 数据管理里的使用次数：未删除的题目、资料，以及回收站中的对象。 */
import type { UsageDTO } from '@shared/api';

export const NO_USAGE: UsageDTO = { problems: 0, materials: 0, trashed: 0 };

/** “3 道题、1 份资料、回收站中 2 项”；都为 0 时为“未使用”。 */
export function usage(u: UsageDTO): string {
  const parts = [];
  if (u.problems) parts.push(`${u.problems} 道题`);
  if (u.materials) parts.push(`${u.materials} 份资料`);
  if (u.trashed) parts.push(`回收站中 ${u.trashed} 项`);
  return parts.length ? parts.join('、') : '未使用';
}

export const used = (u: UsageDTO) => u.problems + u.materials + u.trashed > 0;

export const sumUsage = (xs: readonly UsageDTO[]): UsageDTO => ({
  problems: xs.reduce((a, x) => a + x.problems, 0),
  materials: xs.reduce((a, x) => a + x.materials, 0),
  trashed: xs.reduce((a, x) => a + x.trashed, 0),
});

/**
 * 确认文字里的影响范围，例如“约 3 道题、1 份资料”；没有对象在用时为 null。
 * 几组各自去重的计数相加时，同一对象可能落在两组里被算两次，所以多组时写“约”。
 */
export function scopeText(xs: readonly UsageDTO[]): string | null {
  const s = sumUsage(xs);
  return used(s) ? `${xs.length > 1 ? '约 ' : ''}${usage(s)}` : null;
}

/** 确认文字的结尾：可以撤销的操作提示一句。 */
export const UNDO_HINT = '完成后可以在提示里撤销。';
