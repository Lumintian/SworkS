/** 注册全部内置操作（进程内只注册一次）。 */
import { assetOps } from './assets.js';
import { catalogOps } from './catalog.js';
import { problemOps } from './problems.js';
import { listOps, registerOps, type OpDef } from './registry.js';
import { searchOps } from './search.js';
import { studentOps } from './students.js';

export { getOp, invokeOp, listOps, type Caller, type OpAccess, type OpDef } from './registry.js';

/** 全部内置操作（插件接口据此推出操作名与输入、输出类型） */
export const BUILTIN_OPS = [...searchOps, ...problemOps, ...catalogOps, ...studentOps, ...assetOps];
export type BuiltinOp = (typeof BUILTIN_OPS)[number];
export type BuiltinOpName = BuiltinOp['name'];

let registered = false;

export function ensureOpsRegistered(): void {
  if (registered) return;
  registered = true;
  registerOps(BUILTIN_OPS as unknown as OpDef[]);
}

export function allOpNames(): string[] {
  ensureOpsRegistered();
  return listOps().map((o) => o.name);
}
