/**
 * 插件接口（本轮只有类型，运行时在下一轮实现；设计见 docs/plugins.md）。
 *
 * 插件与 MCP 用同一个能力面（ops/）：读写都经操作注册表，写入走整体保存，
 * 所以版本递增、检索投影重建、409 冲突等不变量对插件同样成立。插件拿不到数据库句柄。
 * 钩子在写入提交之后异步执行，失败被隔离，不能阻塞或改写用户的保存。
 */
import type { z } from 'zod';
import type { ServerEvents } from '../events/types.js';
import type { BuiltinOp, BuiltinOpName } from '../ops/index.js';
import type { OpAccess } from '../ops/registry.js';

/** 接口版本：`package.json` 的 `"sworks": { "apiVersion": 1 }` 必须与之相同 */
export type SworksPluginApiVersion = 1;

// ---------------------------------------------------------------- 清单

/**
 * `<数据目录>/plugins/<id>/package.json` 里的 `"sworks"` 字段。
 * 没有 package.json 时，目录里的 index.ts / index.js 视为入口，id 取目录名。
 */
export interface PluginManifest {
  apiVersion: SworksPluginApiVersion;
  /** 小写字母、数字与连字符，全局唯一；也是 MCP 工具名前缀（`<id>__<name>`） */
  id: string;
  /** 显示名称 */
  name: string;
  version: string;
  /** 相对插件目录的入口文件，默认 index.ts 或 index.js（Node 24 原生擦除类型，只支持可擦除的 TypeScript 语法） */
  entry?: string;
  description?: string;
}

// ---------------------------------------------------------------- 基础设施

export interface PluginLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** 内置操作的输入（调用方写的形式，允许省略有默认值的字段） */
export type OpInput<N extends BuiltinOpName> = z.input<Extract<BuiltinOp, { name: N }>['input']>;
/** 内置操作的返回值 */
export type OpOutput<N extends BuiltinOpName> = Awaited<ReturnType<Extract<BuiltinOp, { name: N }>['run']>>;

export interface OpInfo {
  name: string;
  title: string;
  description: string;
  access: OpAccess;
}

/** 插件注册的工具的全名 */
export type PluginToolName = `${string}__${string}`;

/**
 * 调用操作：内置操作带类型；插件注册的工具按全名（`<id>__<name>`）调用、返回 unknown。
 * 内置操作名里没有 `__`，所以写错内置操作的输入不会落到无类型的重载上。以插件来源运行。
 */
export interface OpsClient {
  invoke<N extends BuiltinOpName>(name: N, input: OpInput<N>, opts?: { signal?: AbortSignal }): Promise<OpOutput<N>>;
  invoke(name: PluginToolName, input: unknown, opts?: { signal?: AbortSignal }): Promise<unknown>;
  list(): OpInfo[];
}

export interface PluginAssets {
  /** 原始字节（附件就是存下的那份，收录时可能已转换为 WebP） */
  read(assetId: string): Promise<{ bytes: Uint8Array; mime: string }>;
  /** 缩小到长边不超过 maxEdge（默认 1568）的 PNG，base64，直接交给模型 */
  readForModel(assetId: string, opts?: { maxEdge?: number }): Promise<{ base64: string; mime: string; width: number; height: number }>;
}

/** 插件设置：存在 `<数据目录>/plugin-data/<id>/settings.json`（不进备份，可能含 API 密钥），设置页按 schema 生成表单 */
export interface PluginSettings<S> {
  get(): S;
  set(patch: Partial<S>): Promise<S>;
  onChange(listener: (value: S) => void): () => void;
}

// ---------------------------------------------------------------- 任务

export type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** 任务在界面与 SSE（`task.updated`）里的样子 */
export interface TaskInfo {
  id: string;
  pluginId: string;
  name: string;
  state: TaskState;
  progress: { done?: number; total?: number; message?: string };
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** 任务运行时拿到的上下文。取消（用户点“取消”、服务关闭）通过 signal 通知；写入以 {kind:'plugin', pluginId, taskId} 为来源。 */
export interface TaskContext {
  taskId: string;
  signal: AbortSignal;
  progress(p: { done?: number; total?: number; message?: string }): void;
  log: PluginLogger;
  ops: OpsClient;
  assets: PluginAssets;
}

/** 钩子里可以做的事：把耗时工作放进任务队列（钩子本身必须很快返回） */
export interface HookContext {
  /** 返回任务 ID */
  enqueue(name: string, run: (t: TaskContext) => Promise<void>): string;
  log: PluginLogger;
}

/** 插件可以订阅的事件（写入提交之后发出；载荷只有 ID、版本与来源） */
export type PluginEvents = Pick<ServerEvents, 'entities.changed' | 'rawInputs.created' | 'attempts.changed' | 'server.started' | 'server.stopping'>;

// ---------------------------------------------------------------- 注册

export interface PluginToolDef<I extends z.ZodType> {
  /** 插件内唯一；对外是 `<id>__<name>`（MCP 工具名、界面命令） */
  name: string;
  title: string;
  /** 中文说明，写给模型看 */
  description: string;
  input: I;
  access: OpAccess;
  run(input: z.output<I>, t: TaskContext): Promise<unknown>;
}

/** 界面命令：出现在命令面板与题目/资料的右键菜单里，作用于所选对象 */
export interface PluginCommandDef {
  id: string;
  title: string;
  target: 'problems' | 'materials';
  run(ids: string[], t: TaskContext): Promise<void>;
}

/** 后台定时任务（服务运行期间按计划执行；错过的不补跑） */
export interface PluginJobDef {
  id: string;
  title: string;
  schedule: { everyMinutes: number } | { cron: string } | 'manual';
  run(t: TaskContext): Promise<void>;
}

export interface SworksPluginAPI {
  readonly id: string;
  readonly version: string;
  /** `<数据目录>/plugin-data/<id>/`：插件自己的文件（不进备份） */
  readonly dataDir: string;
  readonly log: PluginLogger;
  /** 与 MCP 同一能力面；来源为 {kind:'plugin'} */
  readonly ops: OpsClient;
  readonly assets: PluginAssets;
  registerSettings<S extends z.ZodType>(schema: S, defaults: z.output<S>): PluginSettings<z.output<S>>;
  registerTool<I extends z.ZodType>(def: PluginToolDef<I>): void;
  registerCommand(def: PluginCommandDef): void;
  registerJob(def: PluginJobDef): void;
  /** 提交后异步调用、失败隔离 */
  on<K extends keyof PluginEvents>(type: K, handler: (event: PluginEvents[K], h: HookContext) => void | Promise<void>): () => void;
}

/** 插件入口模块的默认导出 */
export interface SworksPlugin {
  /** 服务开始监听之后调用一次；注册工具、命令、任务与钩子 */
  activate(api: SworksPluginAPI): void | Promise<void>;
  /** 服务关闭前调用（有 5 秒上限） */
  deactivate?(): void | Promise<void>;
}
