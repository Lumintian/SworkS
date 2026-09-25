/** 前后端共享的常量与枚举。 */

export const APP_NAME = 'SworkS';
export const APP_VERSION = '0.1.0';

export const BLOCK_KINDS = ['markdown', 'text', 'image'] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

export const NOTE_TYPES = ['note', 'answer', 'solution'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

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

export const SEARCH_FIELDS = ['title', 'content', 'note', 'answer', 'solution', 'tag', 'source'] as const;
export type SearchField = (typeof SEARCH_FIELDS)[number];

export const SEARCH_FIELD_LABELS: Record<SearchField, string> = {
  title: '标题',
  content: '正文',
  note: '笔记',
  answer: '答案',
  solution: '解析',
  tag: '标签',
  source: '来源备注',
};

/** 支持的图片格式；其他格式必须显式失败。 */
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

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
