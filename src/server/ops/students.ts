/** 学生与作答记录的操作（作答不改变题目版本）。 */
import { z } from 'zod';
import { attemptCreateSchema } from '../../shared/api.js';
import { createAttempt, listStudents } from '../services/students.js';
import { defineOp } from './registry.js';

export const studentOps = [
  defineOp({
    name: 'list_students',
    title: '列出学生',
    description: '列出学生（未归档）及其作答统计。',
    input: z.object({}).strict(),
    access: 'read',
    run: (ctx) => listStudents(ctx.db).map((s) => ({ id: s.id, name: s.name, stage: s.stage, stats: s.stats })),
  }),
  defineOp({
    name: 'record_attempt',
    title: '记录作答',
    description: '记录某个学生做某道题的一次结果：correct（对）、partial（部分对）、wrong（错）、blank（没做）。id 由调用方生成时重试不会重复记录。',
    input: attemptCreateSchema.partial({ id: true }),
    access: 'write',
    idempotent: true,
    run: (ctx, input) => {
      const r = createAttempt(ctx.db, { ...input, id: input.id ?? crypto.randomUUID() });
      return { attempt: r.attempt, created: r.created };
    },
  }),
];
