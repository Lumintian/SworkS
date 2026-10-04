/** 前后端共享的请求校验 schema 与响应类型。 */
import { z } from 'zod';
import { isUuid } from './assetRef.js';
import type { ListSort } from './listFilters.js';
import type { Diagnostic } from './query/ast.js';
import {
  ATTEMPT_RESULTS,
  BLOCK_KINDS,
  MATERIAL_STATUSES,
  type AttemptResult,
  NOTE_SEQ_MAX,
  NOTE_TYPES,
  PROPERTY_TYPES,
  type PropertyPreset,
  type PropertyType,
  type AssetMime,
  type BlockKind,
  type MaterialStatus,
  type NoteType,
  type SearchField,
} from './constants.js';

const id = z.uuid();
const optionalText = (max: number) => z.string().max(max).nullable().optional();

export const blockInputSchema = z
  .object({
    id,
    kind: z.enum(BLOCK_KINDS),
    body: z.string().max(2_000_000).nullable().optional(),
    assetId: id.nullable().optional(),
    remoteImageId: id.nullable().optional(),
    caption: optionalText(2_000),
  })
  .strict();
export type BlockInput = z.infer<typeof blockInputSchema>;

export const noteInputSchema = z
  .object({
    id,
    type: z.enum(NOTE_TYPES),
    title: optionalText(300),
    bodyMd: z.string().max(2_000_000),
    /** 可选序号（0–999）。省略表示保留原值（旧页面保存时不会抹掉），null 表示清除 */
    seq: z.number().int().min(0).max(NOTE_SEQ_MAX).nullable().optional(),
  })
  .strict();
export type NoteInput = z.infer<typeof noteInputSchema>;

export const sourceLinkInputSchema = z
  .object({
    materialId: id,
    note: optionalText(2_000),
  })
  .strict();
export type SourceLinkInput = z.infer<typeof sourceLinkInputSchema>;

/**
 * 一个属性的取值。按属性类型只填对应字段：单选/多选用 optionIds，文本 text，数字 number，
 * 日期 date（YYYY-MM-DD），勾选 checked。
 */
export const propertyValueInputSchema = z
  .object({
    propertyId: id,
    optionIds: z.array(id).max(200).optional(),
    text: z.string().min(1).max(2_000).optional(),
    number: z.number().finite().optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    checked: z.boolean().optional(),
  })
  .strict();
export type PropertyValueInput = z.infer<typeof propertyValueInputSchema>;

const baseEntityFields = {
  title: optionalText(300),
  subject: optionalText(50),
  stage: optionalText(50),
  sourceNote: optionalText(4_000),
  tags: z.array(z.string().max(60)).max(100).default([]),
  blocks: z.array(blockInputSchema).max(500).default([]),
  /** 本次编辑中产生、尚未归属对象的原始输入记录，保存时挂到该对象。 */
  rawInputIds: z.array(id).max(1_000).default([]),
  /**
   * 自定义属性的完整取值。省略表示不改动；提供时，其中没有出现的（未归档）属性视为清空。
   */
  properties: z.array(propertyValueInputSchema).max(200).optional(),
};

export const problemCreateSchema = z
  .object({
    id,
    ...baseEntityFields,
    notes: z.array(noteInputSchema).max(500).default([]),
    sources: z.array(sourceLinkInputSchema).max(100).default([]),
  })
  .strict();
export type ProblemCreateInput = z.input<typeof problemCreateSchema>;

export const problemUpdateSchema = problemCreateSchema
  .omit({ id: true })
  .extend({ expectedVersion: z.number().int().min(1) })
  .strict();
export type ProblemUpdateInput = z.input<typeof problemUpdateSchema>;

export const materialCreateSchema = z
  .object({
    id,
    ...baseEntityFields,
    status: z.enum(MATERIAL_STATUSES).default('active'),
  })
  .strict();
export type MaterialCreateInput = z.input<typeof materialCreateSchema>;

export const materialUpdateSchema = materialCreateSchema
  .omit({ id: true })
  .extend({ expectedVersion: z.number().int().min(1) })
  .strict();
export type MaterialUpdateInput = z.input<typeof materialUpdateSchema>;

export const deriveProblemSchema = z
  .object({
    problemId: id,
    blockIds: z.array(id).min(1).max(500),
    note: optionalText(2_000),
    markMaterialActive: z.boolean().default(false),
  })
  .strict();

export const rawTextInputSchema = z
  .object({
    text: z.string().min(1).max(2_000_000),
    blockId: id.nullable().optional(),
  })
  .strict();

export const remoteImageCreateSchema = z
  .object({
    url: z.string().min(1).max(4_000),
    blockId: id.nullable().optional(),
  })
  .strict();

export const exportMarkdownSchema = z
  .object({
    problemIds: z.array(id).min(1).max(1_000),
  })
  .strict();

export const entityVersionSchema = z.object({ expectedVersion: z.number().int().min(1).optional() }).strict();

// ---------- 批量操作 ----------

/** 一次批量操作最多涉及的对象数。 */
export const MAX_BATCH_IDS = 1_000;

export const batchActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addTags'), names: z.array(z.string().min(1).max(60)).min(1).max(20) }).strict(),
  z.object({ op: z.literal('removeTags'), tagIds: z.array(id).min(1).max(100) }).strict(),
  z.object({ op: z.literal('setSubject'), value: z.string().max(50).nullable() }).strict(),
  z.object({ op: z.literal('setStage'), value: z.string().max(50).nullable() }).strict(),
  z.object({ op: z.literal('setStatus'), status: z.enum(MATERIAL_STATUSES) }).strict(),
  z.object({ op: z.literal('trash') }).strict(),
  z.object({ op: z.literal('restore') }).strict(),
  /** 设置某个属性的取值（替换原值）；value 为 null 时清空 */
  z.object({ op: z.literal('setProperty'), value: propertyValueInputSchema.nullable(), propertyId: id }).strict(),
  /** 多选属性：追加 / 移除选项，不影响其他选项 */
  z.object({ op: z.literal('addOptions'), propertyId: id, optionIds: z.array(id).min(1).max(50) }).strict(),
  z.object({ op: z.literal('removeOptions'), propertyId: id, optionIds: z.array(id).min(1).max(50) }).strict(),
]);
export type BatchAction = z.infer<typeof batchActionSchema>;

export const batchSchema = z
  .object({
    ids: z.array(id).min(1).max(MAX_BATCH_IDS),
    action: batchActionSchema,
  })
  .strict();
export type BatchInput = z.infer<typeof batchSchema>;

// ---------- 标签与字典管理 ----------

export const tagRenameSchema = z
  .object({
    from: z.string().min(1).max(200),
    to: z.string().min(1).max(200),
  })
  .strict();

export const tagDeleteSchema = z.object({ path: z.string().min(1).max(200) }).strict();

/** 一次删除多个标签（各含子树）。 */
export const tagDeleteManySchema = z.object({ paths: z.array(z.string().min(1).max(200)).min(1).max(500) }).strict();
/** 把多个标签（各含子树）移到某个标签之下（null 为顶层），保留末级名称。 */
export const tagMoveSchema = z.object({ paths: z.array(z.string().min(1).max(200)).min(1).max(500), parent: z.string().min(1).max(200).nullable() }).strict();
/** 把多个标签（各含子树）合并到同一个目标路径。 */
export const tagMergeSchema = z.object({ from: z.array(z.string().min(1).max(200)).min(1).max(500), to: z.string().min(1).max(200) }).strict();

// ---------- 自定义属性管理 ----------

export const propertyCreateSchema = z
  .object({
    id,
    name: z.string().min(1).max(40),
    type: z.enum(PROPERTY_TYPES),
    nested: z.boolean().default(false),
    appliesProblem: z.boolean().default(true),
    appliesMaterial: z.boolean().default(false),
  })
  .strict();

export const propertyUpdateSchema = z
  .object({
    name: z.string().min(1).max(40).optional(),
    showInNav: z.boolean().optional(),
    appliesProblem: z.boolean().optional(),
    appliesMaterial: z.boolean().optional(),
    /** 选项分层：可由平改为分层；有下级选项时不能改回 */
    nested: z.boolean().optional(),
  })
  .strict();

export const idListSchema = z.object({ ids: z.array(id).min(1).max(500) }).strict();

export const optionCreateSchema = z
  .object({
    id,
    label: z.string().min(1).max(60),
    parentId: id.nullable().default(null),
  })
  .strict();

export const optionUpdateSchema = z.object({ label: z.string().min(1).max(60) }).strict();
export const optionMoveSchema = z
  .object({
    parentId: id.nullable(),
    /** 在新父节点下的位置（从 0 开始）；省略表示放到最后 */
    index: z.number().int().min(0).optional(),
  })
  .strict();
export const optionMergeSchema = z.object({ intoId: id }).strict();
export const optionMergeManySchema = z.object({ ids: z.array(id).min(1).max(500), intoId: id }).strict();
export const optionMoveManySchema = z
  .object({
    ids: z.array(id).min(1).max(500),
    parentId: id.nullable(),
    /** 在新父节点下（去掉这些选项后）的位置；省略表示放到最后 */
    index: z.number().int().min(0).optional(),
  })
  .strict();
export const optionPathSchema = z.object({ path: z.string().min(1).max(400) }).strict();
export const outlineImportSchema = z
  .object({
    outline: z.string().min(1).max(200_000),
    /** 试运行：不写入，返回每一行会落到的位置（预览） */
    dryRun: z.boolean().optional(),
  })
  .strict();

// ---------- 学生与作答记录 ----------

export const studentCreateSchema = z
  .object({
    id,
    name: z.string().min(1).max(60),
    stage: optionalText(50),
    note: optionalText(4_000),
  })
  .strict();

export const studentUpdateSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    stage: optionalText(50),
    note: optionalText(4_000),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict();

const attemptFields = {
  result: z.enum(ATTEMPT_RESULTS),
  feltDifficulty: z.number().int().min(1).max(5).nullable().optional(),
  durationSec: z.number().int().min(0).max(24 * 3600).nullable().optional(),
  note: optionalText(4_000),
  attemptedAt: z.iso.datetime({ offset: true }).optional(),
};

export const attemptCreateSchema = z
  .object({
    id,
    studentId: id,
    problemId: id,
    ...attemptFields,
  })
  .strict();

export const attemptUpdateSchema = z
  .object({
    result: z.enum(ATTEMPT_RESULTS).optional(),
    feltDifficulty: z.number().int().min(1).max(5).nullable().optional(),
    durationSec: z.number().int().min(0).max(24 * 3600).nullable().optional(),
    note: optionalText(4_000),
    attemptedAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

/** 批量记录：同一个学生、同一结果，给每道题各记一条（ID 由客户端生成，重试不会重复）。 */
export const attemptBatchSchema = z
  .object({
    studentId: id,
    items: z.array(z.object({ id, problemId: id }).strict()).min(1).max(MAX_BATCH_IDS),
    ...attemptFields,
  })
  .strict();

/** GET /api/attempts 的查询参数：无效的 ID 或数量按“未提供”处理。 */
const lenientUuid = z.string().optional().transform((v) => (v && isUuid(v) ? v.toLowerCase() : undefined));
export const attemptListQuerySchema = z.object({
  studentId: lenientUuid,
  problemId: lenientUuid,
  limit: z.string().optional().transform((v) => (v && /^\d+$/.test(v) ? Number(v) : undefined)),
});

export const DICT_KINDS = ['subject', 'stage'] as const;
export type DictKind = (typeof DICT_KINDS)[number];

export const dictValueSchema = z.object({ value: z.string().min(1).max(50) }).strict();
export const dictRenameSchema = z
  .object({
    from: z.string().min(1).max(50),
    /** null 表示从所有对象上清除这个值 */
    to: z.string().min(1).max(50).nullable(),
  })
  .strict();
export const dictReorderSchema = z.object({ values: z.array(z.string().min(1).max(50)).max(500) }).strict();
export const dictValuesSchema = z.object({ values: z.array(z.string().min(1).max(50)).min(1).max(500) }).strict();
/** 多个值合并到 into；into 为 null 表示从所有对象上清除 */
export const dictMergeSchema = z.object({ values: z.array(z.string().min(1).max(50)).min(1).max(500), into: z.string().min(1).max(50).nullable() }).strict();


// ---------- 响应类型 ----------

export type { ErrorBody as ApiErrorBody, ErrorCode } from './errors.js';

/** 图片存储策略（只影响新收录的图片；已有附件不动）。 */
export const imagePolicySchema = z.object({
  enabled: z.boolean(),
  pngLossless: z.boolean(),
  photoQuality: z.number().int().min(40).max(100),
  maxLongEdge: z.number().int().min(0).max(16383),
  minSaving: z.number().min(0).max(0.9),
}).strict();
export type ImagePolicyDTO = z.infer<typeof imagePolicySchema>;
export const DEFAULT_IMAGE_POLICY: ImagePolicyDTO = { enabled: true, pngLossless: true, photoQuality: 85, maxLongEdge: 3072, minSaving: 0.1 };

export const SAVED_SEARCH_SCOPES = ['problem', 'material'] as const;
export type SavedSearchScope = (typeof SAVED_SEARCH_SCOPES)[number];

export const savedSearchCreateSchema = z
  .object({
    id,
    scope: z.enum(SAVED_SEARCH_SCOPES),
    name: z.string().min(1).max(60),
    /** 查询文本；保存时解析，有错误时拒绝 */
    text: z.string().min(1).max(1000),
    sort: z.string().max(60).nullable().optional(),
    showInNav: z.boolean().optional(),
  })
  .strict();

export const savedSearchUpdateSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    text: z.string().min(1).max(1000).optional(),
    sort: z.string().max(60).nullable().optional(),
    showInNav: z.boolean().optional(),
  })
  .strict();

export const savedSearchReorderSchema = z.object({ scope: z.enum(SAVED_SEARCH_SCOPES), ids: z.array(id).max(500) }).strict();


/** 常用检索。text 按当前名称重新生成（属性、选项、学生改名后仍然有效）。 */
/** MCP 接入的状态（设置页用）。令牌只在本机页面上显示。 */
export interface McpStatusDTO {
  enabled: boolean;
  mode: 'read' | 'write';
  url: string;
  token: string;
  /** Claude Code：`claude mcp add …` */
  claudeCommand: string;
  /** 只支持 stdio 的客户端的配置片段 */
  stdioConfig: string;
  dataDir: string;
}

export interface SavedSearchDTO {
  id: string;
  scope: SavedSearchScope;
  name: string;
  text: string;
  sort: ListSort | null;
  position: number;
  showInNav: boolean;
  /** 条件中已失效的部分（选项、标签或学生已删除等） */
  problems: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AssetDTO {
  id: string;
  sha256: string;
  mime: AssetMime;
  size: number;
  originalFilename: string | null;
  createdAt: string;
}

export type RemoteImageStatus = 'pending' | 'archived' | 'failed';

export interface RemoteImageDTO {
  id: string;
  url: string;
  status: RemoteImageStatus;
  assetId: string | null;
  archivedVia: 'download' | 'manual' | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  updatedAt: string;
}

export interface BlockDTO {
  id: string;
  kind: BlockKind;
  body: string | null;
  assetId: string | null;
  remoteImageId: string | null;
  caption: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NoteDTO {
  id: string;
  problemId: string;
  type: NoteType;
  title: string | null;
  bodyMd: string;
  position: number;
  /** 可选序号（例如对应第几问）；显示顺序仍由 position 决定 */
  seq: number | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface RawInputDTO {
  id: string;
  kind: 'text' | 'file' | 'url';
  text: string | null;
  assetId: string | null;
  url: string | null;
  originalFilename: string | null;
  blockId: string | null;
  capturedAt: string;
  /** 收录时做了格式转换：原文件的格式、大小与哈希（原字节不保留） */
  original: { mime: string; size: number; sha256: string } | null;
}

export interface SourceLinkDTO {
  materialId: string;
  materialTitle: string | null;
  materialDeleted: boolean;
  note: string | null;
  createdAt: string;
}

export interface DerivedProblemDTO {
  problemId: string;
  title: string | null;
  deleted: boolean;
  createdAt: string;
}

/** 一个属性的取值（返回给前端的形式，与 PropertyValueInput 对应）。 */
export interface PropertyValueDTO {
  propertyId: string;
  optionIds?: string[];
  text?: string;
  number?: number;
  date?: string;
  checked?: boolean;
}

export interface PropertyOptionDTO {
  id: string;
  parentId: string | null;
  label: string;
  /** 从根到自身的完整路径，例如“函数/单调性” */
  path: string;
  position: number;
  depth: number;
}

export interface PropertyDefDTO {
  id: string;
  name: string;
  type: PropertyType;
  nested: boolean;
  appliesProblem: boolean;
  appliesMaterial: boolean;
  preset: PropertyPreset | null;
  position: number;
  showInNav: boolean;
  archived: boolean;
  /** 未删除的选项，按树的深度优先顺序 */
  options: PropertyOptionDTO[];
}

export interface StudentStatsDTO {
  /** 做过的不同题目数 */
  problems: number;
  /** 作答总次数 */
  attempts: number;
  correct: number;
  partial: number;
  wrong: number;
  blank: number;
  /** 最近一次没做对的题目数（当前错题） */
  openMistakes: number;
  lastAttemptAt: string | null;
}

export interface StudentDTO {
  id: string;
  name: string;
  stage: string | null;
  note: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
  stats: StudentStatsDTO;
}

export interface AttemptDTO {
  id: string;
  studentId: string;
  studentName: string;
  problemId: string;
  problemTitle: string | null;
  problemSummary: string;
  problemDeleted: boolean;
  attemptedAt: string;
  result: AttemptResult;
  feltDifficulty: number | null;
  durationSec: number | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 某个考点（含子树）上的作答统计。 */
export interface WeakPointDTO {
  optionId: string;
  path: string;
  attempts: number;
  /** 没做对的次数（半对按 0.5 计） */
  misses: number;
  problems: number;
  /** 0–1 */
  missRate: number;
}

export interface StudentDetailDTO extends StudentDTO {
  weakPoints: WeakPointDTO[];
  recentAttempts: AttemptDTO[];
}

/** 列表项上当前学生的作答摘要。 */
export interface AttemptSummaryDTO {
  count: number;
  /** 错与不会的次数 */
  wrong: number;
  partial: number;
  lastResult: AttemptResult;
  lastAt: string;
  lastFelt: number | null;
}

export interface OutlineImportResultDTO {
  created: number;
  existing: number;
  /** 试运行时给出：每一行导入后的完整路径与层级、是否沿用已有选项（最多 2000 行） */
  items?: { path: string; depth: number; existing: boolean }[];
}

interface EntityCommon {
  id: string;
  title: string | null;
  subject: string | null;
  stage: string | null;
  sourceNote: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
  tags: string[];
  /** 未归档属性的取值 */
  properties: PropertyValueDTO[];
  blocks: BlockDTO[];
  /** blocks/notes 引用到的附件与远程图片，便于前端渲染。 */
  assets: Record<string, AssetDTO>;
  remoteImages: Record<string, RemoteImageDTO>;
  /** Markdown 中远程图片 URL → remote image id */
  remoteImageUrls: Record<string, string>;
  rawInputs: RawInputDTO[];
}

export interface ProblemDTO extends EntityCommon {
  notes: NoteDTO[];
  sources: SourceLinkDTO[];
}

export interface MaterialDTO extends EntityCommon {
  status: MaterialStatus;
  derivedProblems: DerivedProblemDTO[];
}

export interface SaveResult<T> {
  entity: T;
  created?: boolean;
  changed: boolean;
}

export interface ListItemDTO {
  id: string;
  title: string | null;
  subject: string | null;
  stage: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  summary: string;
  firstImageAssetId: string | null;
  blockCount: number;
  imageCount: number;
  noteCounts?: Record<NoteType, number>;
  status?: MaterialStatus;
  /** 属性取值的显示文字（选项为完整路径） */
  properties: { propertyId: string; values: string[] }[];
  /** 按学生筛选时：该学生在这道题上的作答摘要（没做过为 null） */
  attempt?: AttemptSummaryDTO | null;
  hits: SearchField[];
  /** 命中片段（只在有正向自由词时生成）：ranges 是 text 中需要高亮的区间 */
  snippets?: SnippetDTO[];
}

export interface SnippetDTO {
  field: SearchField;
  text: string;
  ranges: [number, number][];
}

export interface ListResponse {
  items: ListItemDTO[];
  total: number;
  offset: number;
  limit: number;
  /** 实际使用的排序（sort 省略时按是否有自由词决定） */
  sortApplied: ListSort;
  /** 查询文本的诊断（语法警告、未知选项等） */
  diagnostics: Diagnostic[];
  /** 列表的“按学生查看”上下文：地址栏的 student 参数，或查询里第一个正向的学生条件 */
  studentId: string | null;
}

export interface ListIdsResponse {
  ids: string[];
  total: number;
  /** 超过上限时只返回前 MAX_BATCH_IDS 个 */
  truncated: boolean;
}

export interface BatchResultDTO {
  /** 实际发生变化的对象 */
  changed: string[];
  /** 没有变化（已满足条件）的对象数 */
  unchanged: number;
  /** 因在回收站中而跳过的对象数 */
  skipped: number;
  /** addTags：解析（或新建）后的标签 ID，便于撤销 */
  tagIds?: string[];
}

export interface NavCountDTO {
  value: string;
  count: number;
}

export interface NavDTO {
  library: { problems: number; materials: number; inbox: number };
  /** 当前集合中至少被一个（未删除）对象使用的标签，以及直接计数 */
  tags: { id: string; name: string; count: number }[];
  /** 标签树各节点（tagKey）下不重复的对象数，含子孙 */
  tagTreeCounts: Record<string, number>;
  untagged: number;
  subjects: NavCountDTO[];
  stages: NavCountDTO[];
  noSubject: number;
  noStage: number;
  /** 显示在导航中的单选/多选/勾选属性 */
  properties: NavPropertyDTO[];
}

export interface NavPropertyDTO {
  propertyId: string;
  /** 选项 ID → 该选项子树下不重复的对象数；勾选属性用键 "__true__" */
  counts: Record<string, number>;
  /** 没有设置这个属性的对象数 */
  none: number;
}

export interface TagRenameResultDTO {
  renamed: number;
  merged: number;
  affectedItems: number;
  /** 可撤销时给出：短时间内 POST /api/undo/:id 撤销 */
  undoId?: string;
}

/** 使用次数：未删除的题目、资料，以及回收站中的对象（题目与资料合计）。 */
export interface UsageDTO {
  problems: number;
  materials: number;
  trashed: number;
}

export interface DictEntryDTO {
  value: string;
  /** 是否在候选列表（字典）中；否则只是有对象在使用 */
  inDict: boolean;
  problemCount: number;
  materialCount: number;
  /** 回收站中使用这个值的题目与资料数（改名、合并、清除同样作用于它们） */
  trashedCount: number;
}

export interface DictManageDTO {
  subject: DictEntryDTO[];
  stage: DictEntryDTO[];
}

export interface TagDTO {
  id: string;
  name: string;
  problemCount: number;
  materialCount: number;
}

/** 数据管理的标签树。 */
export interface TagManageDTO {
  /** 全部标签行；used 为假表示没有任何对象（含回收站中的）在用它 */
  tags: { id: string; name: string; used: boolean }[];
  /** 标签树各节点（tagKey）下不重复的对象数，含子孙 */
  usage: Record<string, UsageDTO>;
}

export interface TrashDTO {
  problems: { id: string; title: string | null; summary: string; deletedAt: string }[];
  materials: { id: string; title: string | null; summary: string; deletedAt: string }[];
  notes: {
    id: string;
    problemId: string;
    problemTitle: string | null;
    problemDeleted: boolean;
    type: NoteType;
    title: string | null;
    summary: string;
    deletedAt: string;
  }[];
}

export interface SessionDTO {
  csrfToken: string;
  appVersion: string;
  schemaVersion: number;
  libraryId: string;
  dataDir: string;
  address: string;
  lastBackupAt: string | null;
  limits: {
    maxImageBytes: number;
    remoteTimeoutMs: number;
    maxRedirects: number;
    allowFakeIpDns: boolean;
  };
}

export interface BackupInfoDTO {
  fileName: string;
  size: number;
  createdAt: string;
}

export interface BackupResultDTO extends BackupInfoDTO {
  counts: Record<string, number>;
  assetFiles: number;
  unarchivedRemoteImages: { url: string; status: RemoteImageStatus; errorMessage: string | null }[];
}

export interface UploadResultDTO {
  asset: AssetDTO;
  rawInputId: string;
  /** 收录时做了格式转换（例如 HEIC → WebP） */
  conversion?: { from: string; to: string; originalSize: number; storedSize: number };
}

export interface TextFileImportDTO {
  rawInputId: string;
  asset: AssetDTO;
  text: string;
  kind: 'markdown' | 'text';
  missingLocalImages: string[];
  remoteImageUrls: string[];
}

export interface RemoteImageCreateDTO {
  remoteImage: RemoteImageDTO;
  asset: AssetDTO | null;
  rawInputId: string;
}
