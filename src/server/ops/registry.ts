/**
 * 操作注册表：MCP 工具与（下一轮的）插件共用的能力面。
 * REST 路由照旧直接调用服务；这里只收外部调用方需要的操作，每个操作自带 zod 输入校验与权限级别。
 * invokeOp 统一做：权限（只读调用方不能写）→ 输入校验 → 取消检查 → 以调用方的来源运行（变更事件带上来源）。
 */
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { originStore } from '../events/changes.js';
import type { Origin } from '../events/types.js';

export type OpAccess = 'read' | 'write' | 'destructive';

export interface Caller {
  origin: Origin;
  /** 只读调用方：拒绝 write / destructive 操作 */
  readOnly?: boolean;
  signal?: AbortSignal;
}

export interface OpDef<I extends z.ZodType = z.ZodType, O = unknown, N extends string = string> {
  /** snake_case，即 MCP 工具名 */
  name: N;
  title: string;
  /** 中文，写给模型/插件看 */
  description: string;
  input: I;
  access: OpAccess;
  /** 用同样的输入重复调用不会产生额外变化 */
  idempotent?: boolean;
  run(ctx: AppContext, input: z.output<I>, caller: Caller): Promise<O> | O;
}

/** 定义一个操作（保留名称字面量与输入、输出类型，插件接口据此给出带类型的 invoke）。 */
export function defineOp<I extends z.ZodType, O, const N extends string>(def: OpDef<I, O, N>): OpDef<I, O, N> {
  return def;
}

const registry = new Map<string, OpDef>();

export function registerOps(defs: readonly OpDef[]): void {
  for (const d of defs) {
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(d.name)) throw new Error(`操作名不合法：${d.name}`);
    if (registry.has(d.name)) throw new Error(`操作重复注册：${d.name}`);
    registry.set(d.name, d as OpDef);
  }
}

export function listOps(opts: { readOnly?: boolean } = {}): OpDef[] {
  return [...registry.values()].filter((o) => !opts.readOnly || o.access === 'read');
}

export function getOp(name: string): OpDef | undefined {
  return registry.get(name);
}

export async function invokeOp(ctx: AppContext, name: string, raw: unknown, caller: Caller): Promise<unknown> {
  const op = registry.get(name);
  if (!op) throw new AppError('NOT_FOUND', `没有名为 ${name} 的操作`);
  if (caller.readOnly && op.access !== 'read') throw new AppError('FORBIDDEN', `只读模式下不能调用 ${name}`);
  const parsed = op.input.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError('VALIDATION', `参数无效：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(), {
      details: parsed.error.issues.slice(0, 5),
    });
  }
  if (caller.signal?.aborted) throw new AppError('VALIDATION', '调用已取消');
  return originStore.run(caller.origin, () => op.run(ctx, parsed.data, caller));
}
