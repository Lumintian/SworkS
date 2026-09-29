/**
 * 外部调用方（AI、插件）按名称与路径指定属性和选项；这里把它们换成 ID。
 * 选项路径先精确匹配完整路径，再按末尾几段匹配（“完型填空”→“英语/完型填空”）；有多个候选时报错并列出。
 */
import { z } from 'zod';
import type { PropertyDefDTO, PropertyValueInput } from '../../shared/api.js';
import type { DB } from '../db/connection.js';
import { AppError } from '../errors.js';
import { ensureOptionPath, listPropertyDefs } from '../services/properties.js';

export const propertyAssignmentSchema = z
  .object({
    property: z.string().min(1).max(60).describe('属性名称（例如“题型”“难度”“考点”）或属性 ID'),
    value: z
      .union([z.string().max(2000), z.array(z.string().max(300)).max(50), z.number(), z.boolean(), z.null()])
      .describe('单选：选项路径；多选：路径数组；文本/日期（YYYY-MM-DD）：字符串；数字；勾选：true/false；null 表示清空'),
  })
  .strict();
export type PropertyAssignment = z.infer<typeof propertyAssignmentSchema>;

const segKey = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const pathSegs = (p: string) => p.split('/').map(segKey).filter(Boolean);

export function findProperty(db: DB, nameOrId: string): PropertyDefDTO {
  const defs = listPropertyDefs(db);
  const key = segKey(nameOrId);
  const d = defs.find((x) => x.id === nameOrId.toLowerCase()) ?? defs.find((x) => segKey(x.name) === key);
  if (!d) throw new AppError('VALIDATION', `没有名为“${nameOrId}”的属性。现有属性：${defs.map((x) => x.name).join('、')}`);
  return d;
}

/** 在属性里按路径找选项；找不到且 create 为真时按路径新建。 */
export function resolveOption(db: DB, def: PropertyDefDTO, path: string, create: boolean): string {
  const want = pathSegs(path);
  if (want.length === 0) throw new AppError('VALIDATION', `“${def.name}”的选项不能为空`);
  const exact = def.options.find((o) => pathSegs(o.path).join('/') === want.join('/'));
  if (exact) return exact.id;
  const suffix = def.options.filter((o) => {
    const segs = pathSegs(o.path);
    return segs.length > want.length && segs.slice(-want.length).join('/') === want.join('/');
  });
  if (suffix.length === 1) return suffix[0]!.id;
  if (suffix.length > 1) throw new AppError('VALIDATION', `“${path}”在“${def.name}”中有多个匹配：${suffix.map((o) => o.path).join('、')}，请写完整路径`);
  if (!create) throw new AppError('VALIDATION', `“${def.name}”中没有选项“${path}”（可设置 createMissingOptions 自动新建）`);
  return ensureOptionPath(db, def.id, path);
}

/**
 * 把按名称的赋值合并进当前取值，返回完整的属性取值列表（供整体保存）。
 * 没有提到的属性保持原值；value 为 null 表示清空。
 */
export function applyAssignments(db: DB, current: readonly PropertyValueInput[], assignments: readonly PropertyAssignment[], createMissing: boolean): PropertyValueInput[] {
  const byId = new Map(current.map((v) => [v.propertyId, v]));
  for (const a of assignments) {
    const def = findProperty(db, a.property);
    if (def.archived) throw new AppError('VALIDATION', `属性“${def.name}”已归档`);
    if (a.value === null || (Array.isArray(a.value) && a.value.length === 0)) {
      byId.delete(def.id);
      continue;
    }
    const v = a.value;
    const bad = () => new AppError('VALIDATION', `属性“${def.name}”的取值类型不对`);
    let next: PropertyValueInput;
    switch (def.type) {
      case 'select':
        if (typeof v !== 'string') throw bad();
        next = { propertyId: def.id, optionIds: [resolveOption(db, def, v, createMissing)] };
        break;
      case 'multiselect': {
        const list = typeof v === 'string' ? [v] : Array.isArray(v) ? v : null;
        if (!list) throw bad();
        // 新建选项后需要重新读取定义，才能在同一批里匹配到它
        const ids = list.map((p) => resolveOption(db, findProperty(db, def.id), p, createMissing));
        next = { propertyId: def.id, optionIds: [...new Set(ids)] };
        break;
      }
      case 'text':
        if (typeof v !== 'string' || !v.trim()) throw bad();
        next = { propertyId: def.id, text: v.trim() };
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw bad();
        next = { propertyId: def.id, number: v };
        break;
      case 'date':
        if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad();
        next = { propertyId: def.id, date: v };
        break;
      case 'checkbox':
        if (typeof v !== 'boolean') throw bad();
        next = { propertyId: def.id, checked: v };
        break;
      default:
        throw bad();
    }
    byId.set(def.id, next);
  }
  return [...byId.values()];
}
