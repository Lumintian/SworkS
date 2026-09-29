/** 目录类操作：属性与选项、标签。 */
import { z } from 'zod';
import { listTags } from '../services/catalog.js';
import { listPropertyDefs } from '../services/properties.js';
import { findProperty, resolveOption } from './resolve.js';
import { defineOp } from './registry.js';

export const catalogOps = [
  defineOp({
    name: 'list_properties',
    title: '列出属性',
    description: '列出全部自定义属性（题型、难度、考点等）及其选项的完整路径与 ID。设置属性、检索前可先调用它确认名称。',
    input: z.object({}).strict(),
    access: 'read',
    run: (ctx) =>
      listPropertyDefs(ctx.db).map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        nested: d.nested,
        appliesTo: [...(d.appliesProblem ? ['problem'] : []), ...(d.appliesMaterial ? ['material'] : [])],
        options: d.options.map((o) => ({ id: o.id, path: o.path })),
      })),
  }),
  defineOp({
    name: 'list_tags',
    title: '列出标签',
    description: '列出正在使用的标签（用 / 分层）及使用它的题目数、资料数。',
    input: z.object({}).strict(),
    access: 'read',
    run: (ctx) => listTags(ctx.db).map((t) => ({ name: t.name, problems: t.problemCount, materials: t.materialCount })),
  }),
  defineOp({
    name: 'ensure_option_path',
    title: '确保选项存在',
    description: '在单选/多选属性里按路径找到选项，不存在的层级自动新建；返回末级选项 ID。',
    input: z.object({ property: z.string().min(1).max(60), path: z.string().min(1).max(300) }).strict(),
    access: 'write',
    idempotent: true,
    run: (ctx, input) => {
      const def = findProperty(ctx.db, input.property);
      return { propertyId: def.id, optionId: resolveOption(ctx.db, def, input.path, true) };
    },
  }),
];
