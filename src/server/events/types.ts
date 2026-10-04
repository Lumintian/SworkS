/**
 * 服务端事件的类型：变更来源与事件载荷。
 * 事件只携带 ID、版本与来源，不含内容；订阅方需要内容时自行读取。
 */

/** 一次写入的来源：页面（带标签页 ID）、MCP 客户端、插件或服务自身。 */
export type Origin =
  | { kind: 'web'; clientId?: string }
  | { kind: 'mcp'; client?: string }
  | { kind: 'plugin'; pluginId: string; taskId?: string }
  | { kind: 'system'; source: 'archiver' | 'startup' | 'cli' };

export interface EntityRef {
  id: string;
  version: number;
  deleted: boolean;
}

export type CatalogPart = 'tags' | 'dict' | 'properties' | 'savedSearches' | 'students';

export interface ServerEvents {
  /** 题目/资料的内容或检索投影变化。reindexOnly 中的对象版本未变（例如选项改名）。 */
  'entities.changed': { problems: EntityRef[]; materials: EntityRef[]; created: string[]; reindexOnly: string[]; origin: Origin };
  'catalog.changed': { parts: CatalogPart[]; origin: Origin };
  'attempts.changed': { studentIds: string[]; problemIds: string[]; origin: Origin };
  /** 教案变化（版本与题目无关）。 */
  'lessons.changed': { lessons: EntityRef[]; created: string[]; origin: Origin };
  'rawInputs.created': { ids: string[]; assetIds: string[]; origin: Origin };
  'remoteImages.changed': { ids: string[]; origin: Origin };
  'server.started': { url: string; bootId: string };
  'server.stopping': Record<string, never>;
  // 保留给下一轮：'task.updated'
}

export type ServerEventType = keyof ServerEvents;

/** 会推送给页面（SSE）的变更事件。 */
export const CHANGE_EVENT_TYPES = [
  'entities.changed',
  'catalog.changed',
  'attempts.changed',
  'lessons.changed',
  'rawInputs.created',
  'remoteImages.changed',
] as const;
export type ChangeEventType = (typeof CHANGE_EVENT_TYPES)[number];
