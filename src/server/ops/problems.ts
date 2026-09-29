/**
 * 题目相关的操作。写操作一律走 patchProblem：同一事务里读出整份题目 → 修改 → 走现有的整体保存，
 * 不新增写入路径（版本递增、重建检索投影、409 等不变量照常成立）。
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { noteInputSchema, problemUpdateSchema, type PropertyValueInput, type ProblemDTO, type SaveResult } from '../../shared/api.js';
import { NOTE_SEQ_MAX, NOTE_TYPES } from '../../shared/constants.js';
import { tagKey } from '../../shared/tagPath.js';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { createProblem, loadMaterial, loadProblem, setDeleted, updateProblem, type ProblemWrite } from '../services/entities.js';
import { applyAssignments, propertyAssignmentSchema } from './resolve.js';
import { defineOp } from './registry.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
const expectedVersion = z.number().int().min(1).optional().describe('期望的当前版本；与实际不符时返回冲突，不写入。省略则以读取时的版本为准');

function toWrite(p: ProblemDTO): ProblemWrite {
  return {
    title: p.title,
    subject: p.subject,
    stage: p.stage,
    sourceNote: p.sourceNote,
    tags: [...p.tags],
    blocks: p.blocks.map((b) => ({ id: b.id, kind: b.kind, body: b.body, assetId: b.assetId, remoteImageId: b.remoteImageId, caption: b.caption })),
    notes: p.notes.map((n) => ({ id: n.id, type: n.type, title: n.title, bodyMd: n.bodyMd, seq: n.seq })),
    sources: p.sources.map((s) => ({ materialId: s.materialId, note: s.note })),
    rawInputIds: [],
  };
}

/** 读出题目 → mutate 修改草稿 → 整体保存（一个事务）。没有实际变化时不递增版本。 */
export function patchProblem(ctx: AppContext, id: string, expected: number | undefined, mutate: (w: ProblemWrite, current: ProblemDTO) => void): SaveResult<ProblemDTO> {
  return ctx.db.transaction(() => {
    const cur = loadProblem(ctx.db, id);
    if (!cur) throw new AppError('NOT_FOUND', '题目不存在');
    if (expected !== undefined && expected !== cur.version) {
      throw new AppError('CONFLICT', '题目已被修改，请重新读取后再试', { details: { currentVersion: cur.version, expectedVersion: expected } });
    }
    const w = toWrite(cur);
    mutate(w, cur);
    return updateProblem(ctx, id, cur.version, w);
  })();
}

/** 返回给调用方的精简结果 */
const saved = (r: SaveResult<ProblemDTO>) => ({ id: r.entity.id, version: r.entity.version, changed: r.changed, ...(r.created !== undefined ? { created: r.created } : {}) });

function problemIdOfNote(ctx: AppContext, noteId: string): string {
  const row = ctx.db.prepare('SELECT problem_id FROM notes WHERE id = ? AND deleted_at IS NULL').get(noteId) as { problem_id: string } | undefined;
  if (!row) throw new AppError('NOT_FOUND', '笔记不存在');
  return row.problem_id;
}

export const problemOps = [
  defineOp({
    name: 'get_problem',
    title: '读取题目',
    description: '按 ID 读取一道题的完整内容：标题、题干内容块（Markdown 与图片附件 ID）、笔记/解析/答案、标签、属性（选项 ID，可用 list_properties 对照名称）、版本号。',
    input: z.object({ id: uuid }).strict(),
    access: 'read',
    run: (ctx, { id }) => {
      const p = loadProblem(ctx.db, id);
      if (!p) throw new AppError('NOT_FOUND', '题目不存在');
      return p;
    },
  }),
  defineOp({
    name: 'get_material',
    title: '读取资料',
    description: '按 ID 读取一份资料的完整内容（内容块、标签、属性、由它建立的题目）。',
    input: z.object({ id: uuid }).strict(),
    access: 'read',
    run: (ctx, { id }) => {
      const m = loadMaterial(ctx.db, id);
      if (!m) throw new AppError('NOT_FOUND', '资料不存在');
      return m;
    },
  }),
  defineOp({
    name: 'create_problem',
    title: '新建题目',
    description:
      '新建一道题。题干用 Markdown（可含 LaTeX 公式 $…$）；图片用已有附件 ID（imageAssetIds，按顺序放在题干之后）。属性按名称与选项路径指定（例如 {property:"题型", value:"英语/完型填空"}）。提供 id 时重试不会重复创建。',
    input: z
      .object({
        id: uuid.optional().describe('客户端生成的 UUID；提供时可安全重试'),
        title: z.string().max(300).optional(),
        markdown: z.string().max(200_000).optional().describe('题干 Markdown'),
        imageAssetIds: z.array(uuid).max(50).optional(),
        subject: z.string().max(50).optional(),
        stage: z.string().max(50).optional(),
        sourceNote: z.string().max(4000).optional().describe('来源备注，例如“某地模拟卷第 12 题”'),
        tags: z.array(z.string().max(60)).max(100).optional().describe('标签，用 / 分层，例如“方法/换元”'),
        properties: z.array(propertyAssignmentSchema).max(50).optional(),
        createMissingOptions: z.boolean().optional().describe('属性选项不存在时自动新建'),
      })
      .strict()
      .refine((v) => v.markdown?.trim() || v.imageAssetIds?.length, { message: '题干 Markdown 与图片至少要有一个' }),
    access: 'write',
    idempotent: true,
    run: (ctx, input) => {
      const id = input.id ?? randomUUID();
      return ctx.db.transaction(() => {
        const properties: PropertyValueInput[] | undefined = input.properties ? applyAssignments(ctx.db, [], input.properties, input.createMissingOptions ?? false) : undefined;
        const blocks = [
          ...(input.markdown?.trim() ? [{ id: randomUUID(), kind: 'markdown' as const, body: input.markdown }] : []),
          ...(input.imageAssetIds ?? []).map((assetId) => ({ id: randomUUID(), kind: 'image' as const, assetId })),
        ];
        return saved(
          createProblem(ctx, id, {
            title: input.title ?? null,
            subject: input.subject ?? null,
            stage: input.stage ?? null,
            sourceNote: input.sourceNote ?? null,
            tags: input.tags ?? [],
            blocks,
            notes: [],
            sources: [],
            rawInputIds: [],
            properties,
          }),
        );
      })();
    },
  }),
  defineOp({
    name: 'update_problem',
    title: '整体保存题目',
    description: '用完整内容覆盖一道题（与编辑页保存相同）：必须带 expectedVersion；省略的笔记会移到已删除，省略 properties 表示不改属性。通常优先用 add_note、set_properties 等局部操作。',
    input: problemUpdateSchema.extend({ id: uuid }),
    access: 'write',
    run: (ctx, input) => {
      const { id, expectedVersion: ev, ...rest } = input;
      return saved(updateProblem(ctx, id, ev, rest));
    },
  }),
  defineOp({
    name: 'add_note',
    title: '添加笔记/解析/答案',
    description: '给题目追加一条笔记（type=note）、解析（solution）或答案（answer），正文为 Markdown。seq 为可选序号（例如对应第几问）。提供 id 时重试不会重复添加。',
    input: z
      .object({
        problemId: uuid,
        expectedVersion,
        id: uuid.optional(),
        type: z.enum(NOTE_TYPES),
        title: z.string().max(300).optional(),
        bodyMd: z.string().min(1).max(200_000),
        seq: z.number().int().min(0).max(NOTE_SEQ_MAX).optional(),
      })
      .strict(),
    access: 'write',
    idempotent: true,
    run: (ctx, input) => {
      const noteId = input.id ?? randomUUID();
      const r = patchProblem(ctx, input.problemId, input.expectedVersion, (w) => {
        if (w.notes.some((n) => n.id === noteId)) return;
        w.notes.push({ id: noteId, type: input.type, title: input.title ?? null, bodyMd: input.bodyMd, seq: input.seq ?? null });
      });
      return { ...saved(r), noteId };
    },
  }),
  defineOp({
    name: 'update_note',
    title: '修改笔记',
    description: '修改一条笔记的正文、标题、类型或序号；只改提供的字段（seq 为 null 表示清除序号）。',
    input: z
      .object({
        noteId: uuid,
        expectedVersion,
        type: z.enum(NOTE_TYPES).optional(),
        title: z.string().max(300).nullable().optional(),
        bodyMd: z.string().min(1).max(200_000).optional(),
        seq: noteInputSchema.shape.seq,
      })
      .strict(),
    access: 'write',
    run: (ctx, input) => {
      const r = patchProblem(ctx, problemIdOfNote(ctx, input.noteId), input.expectedVersion, (w) => {
        const n = w.notes.find((x) => x.id === input.noteId)!;
        if (input.type !== undefined) n.type = input.type;
        if (input.title !== undefined) n.title = input.title;
        if (input.bodyMd !== undefined) n.bodyMd = input.bodyMd;
        if (input.seq !== undefined) n.seq = input.seq;
      });
      return saved(r);
    },
  }),
  defineOp({
    name: 'set_properties',
    title: '设置属性',
    description: '按名称设置题目的属性（题型、难度、考点等）；没提到的属性保持不变，value 为 null 表示清空。选项用路径表示，可只写末级（唯一时）。',
    input: z
      .object({
        problemId: uuid,
        expectedVersion,
        values: z.array(propertyAssignmentSchema).min(1).max(50),
        createMissingOptions: z.boolean().optional().describe('选项不存在时按路径自动新建'),
      })
      .strict(),
    access: 'write',
    run: (ctx, input) =>
      saved(
        patchProblem(ctx, input.problemId, input.expectedVersion, (w, cur) => {
          w.properties = applyAssignments(ctx.db, cur.properties, input.values, input.createMissingOptions ?? false);
        }),
      ),
  }),
  defineOp({
    name: 'add_tags',
    title: '添加标签',
    description: '给题目添加标签（用 / 分层，例如“方法/换元”）；已有的不重复。',
    input: z.object({ problemId: uuid, expectedVersion, tags: z.array(z.string().min(1).max(60)).min(1).max(50) }).strict(),
    access: 'write',
    idempotent: true,
    run: (ctx, input) =>
      saved(
        patchProblem(ctx, input.problemId, input.expectedVersion, (w) => {
          const have = new Set(w.tags.map(tagKey));
          for (const t of input.tags) if (!have.has(tagKey(t))) w.tags.push(t);
        }),
      ),
  }),
  defineOp({
    name: 'remove_tags',
    title: '移除标签',
    description: '从题目上移除标签（按完整路径，不区分大小写；不会移除下级标签）。',
    input: z.object({ problemId: uuid, expectedVersion, tags: z.array(z.string().min(1).max(60)).min(1).max(50) }).strict(),
    access: 'write',
    idempotent: true,
    run: (ctx, input) =>
      saved(
        patchProblem(ctx, input.problemId, input.expectedVersion, (w) => {
          const drop = new Set(input.tags.map(tagKey));
          w.tags = w.tags.filter((t) => !drop.has(tagKey(t)));
        }),
      ),
  }),
  defineOp({
    name: 'trash_problem',
    title: '移到回收站',
    description: '把题目移到回收站（可在回收站恢复，不会永久删除）。',
    input: z.object({ problemId: uuid }).strict(),
    access: 'destructive',
    idempotent: true,
    run: (ctx, { problemId }) => ({ id: problemId, version: setDeleted(ctx, 'problem', problemId, true) }),
  }),
];
