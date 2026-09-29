/** 前后端共享的常量与枚举。 */

export const APP_NAME = 'SworkS';
export const APP_VERSION = '0.1.0';

export const BLOCK_KINDS = ['markdown', 'text', 'image'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const NOTE_TYPES = ['note', 'answer', 'solution'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
/** 笔记按类型分栏显示与导出时的顺序：笔记 → 解析 → 答案 */
export const NOTE_TAB_ORDER: readonly NoteType[] = ['note', 'solution', 'answer'];
/** 笔记序号的取值范围 */
export const NOTE_SEQ_MAX = 999;

export const NOTE_TYPE_LABELS: Record<NoteType, string> = {
  note: '笔记',
  answer: '答案',
  solution: '解析',
};

export const MATERIAL_STATUSES = ['inbox', 'active'] as const;
export type MaterialStatus = (typeof MATERIAL_STATUSES)[number];

export const MATERIAL_STATUS_LABELS: Record<MaterialStatus, string> = {
  inbox: '待整理',
  active: '已整理',
};

export const SEARCH_FIELDS = ['title', 'content', 'note', 'answer', 'solution', 'tag', 'property', 'source'] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

export const SEARCH_FIELD_LABELS: Record<SearchField, string> = {
  title: '标题',
  content: '正文',
  note: '笔记',
  answer: '答案',
  solution: '解析',
  tag: '标签',
  property: '属性',
  source: '来源备注',
};

/** 自定义属性的类型（参照 Obsidian 属性与 Notion 字段）。 */
export const PROPERTY_TYPES = ['text', 'number', 'date', 'checkbox', 'select', 'multiselect'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  text: '文本',
  number: '数字',
  date: '日期',
  checkbox: '勾选',
  select: '单选',
  multiselect: '多选',
};

/** 预置属性：代码据此找到题型、难度、考点，名称可以改。 */
export const PROPERTY_PRESETS = ['qtype', 'difficulty', 'knowledge'] as const;
export type PropertyPreset = (typeof PROPERTY_PRESETS)[number];

/** 属性名不能与导出 front matter 的内置键或内置字段重名。 */
export const RESERVED_PROPERTY_NAMES = [
  'id',
  'title',
  'subject',
  'stage',
  'tags',
  'created_at',
  'updated_at',
  'source_note',
  'sources',
  'exported_by',
  '标题',
  '学科',
  '学段',
  '标签',
  '来源备注',
];

/** 作答结果（“不会”单独记，不算作答错）。 */
export const ATTEMPT_RESULTS = ['correct', 'partial', 'wrong', 'blank'] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];

export const ATTEMPT_RESULT_LABELS: Record<AttemptResult, string> = {
  correct: '对',
  partial: '半对',
  wrong: '错',
  blank: '不会',
};

/** 学生对题目的主观难度 1–5。 */
export const FELT_DIFFICULTY_LABELS: Record<number, string> = {
  1: '很简单',
  2: '简单',
  3: '适中',
  4: '难',
  5: '很难',
};

/** 按学生筛选题目时的作答状态。 */
export const ATTEMPT_FILTERS = ['none', 'done', 'wrong-ever', 'wrong-last'] as const;
export type AttemptFilter = (typeof ATTEMPT_FILTERS)[number];

export const ATTEMPT_FILTER_LABELS: Record<AttemptFilter, string> = {
  none: '未做过',
  done: '做过',
  'wrong-ever': '做错过',
  'wrong-last': '最近一次没做对',
};

/**
 * 图片格式的唯一清单。
 * - 可存储：附件只会是这四种；
 * - 只能输入：收录时识别并转换成 WebP 再存（iPhone 的 HEIC/HEIF、AVIF）；
 * 其他格式必须显式失败。
 */
export const STORABLE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMime = (typeof STORABLE_IMAGE_MIMES)[number];
/** 旧名称，与 STORABLE_IMAGE_MIMES 相同 */
export const IMAGE_MIME_TYPES = STORABLE_IMAGE_MIMES;

export const INPUT_ONLY_IMAGE_MIMES = ['image/heic', 'image/heif', 'image/avif'] as const;
export type InputOnlyImageMime = (typeof INPUT_ONLY_IMAGE_MIMES)[number];
export type InputImageMime = ImageMime | InputOnlyImageMime;

/** 文件选择器的 accept：部分浏览器不认识 HEIC 的 MIME，所以同时写扩展名 */
export const IMAGE_ACCEPT = [...STORABLE_IMAGE_MIMES, ...INPUT_ONLY_IMAGE_MIMES, '.heic', '.heif', '.avif'].join(',');

/** File.type 为空时（常见于 HEIC）按扩展名识别 */
export const IMAGE_EXTENSION_MIMES: Record<string, InputImageMime> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
};

export const IMAGE_FORMAT_LABELS: Record<InputImageMime, string> = {
  'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/gif': 'GIF',
  'image/heic': 'HEIC', 'image/heif': 'HEIF', 'image/avif': 'AVIF',
};

/** 文件是不是图片：先看 MIME，为空时看扩展名 */
export function imageMimeOfFile(f: { type: string; name: string }): InputImageMime | null {
  if (f.type && ([...STORABLE_IMAGE_MIMES, ...INPUT_ONLY_IMAGE_MIMES] as readonly string[]).includes(f.type)) return f.type as InputImageMime;
  if (f.type && f.type.startsWith('image/')) return null;
  const ext = f.name.toLowerCase().split('.').pop() ?? '';
  return IMAGE_EXTENSION_MIMES[ext] ?? null;
}

/** 单个文本文件导入（.md / .txt）保存原始字节时使用的类型。 */
export const TEXT_MIME_TYPES = ['text/markdown', 'text/plain'] as const;
export type TextMime = (typeof TEXT_MIME_TYPES)[number];

export type AssetMime = ImageMime | TextMime;

export const MIME_EXTENSIONS: Record<AssetMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'text/markdown': 'md',
  'text/plain': 'txt',
};

export const DEFAULT_SUBJECTS = ['数学', '物理', '化学', '生物', '语文', '英语', '历史', '地理', '政治', '信息技术'];
export const DEFAULT_STAGES = ['小学', '初中', '高中', '大学', '竞赛'];

export const PAGE_SIZE = 20;

/** 修改类请求必须携带的 CSRF 头。 */
export const CSRF_HEADER = 'x-sworks-csrf';
