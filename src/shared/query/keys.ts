/**
 * 查询语言的保留键（中英文别名）与取值词表。键不区分大小写、按 NFKC 比较；
 * 保留键优先于同名属性，与保留键同名的属性写成 `属性.名称:` 或 `prop.名称:`。
 */
import type { AttemptFilter, MaterialStatus, SearchField } from '../constants.js';
import { nameKey } from './normalize.js';

export type TextKey = 'title' | 'content' | 'note' | 'answer' | 'solution' | 'source';
export type ReservedKey = TextKey | 'tag' | 'subject' | 'stage' | 'status' | 'student' | 'created' | 'updated' | 'has' | 'in';

/** 规范写法（序列化时使用） */
export const KEY_LABEL: Record<ReservedKey, string> = {
  title: '标题',
  content: '正文',
  note: '笔记',
  answer: '答案',
  solution: '解析',
  source: '来源',
  tag: '标签',
  subject: '学科',
  stage: '学段',
  status: '状态',
  student: '学生',
  created: '创建',
  updated: '修改',
  has: '有',
  in: '范围',
};

const ALIASES: Record<string, ReservedKey> = {
  标题: 'title',
  title: 'title',
  正文: 'content',
  题干: 'content',
  内容: 'content',
  content: 'content',
  笔记: 'note',
  note: 'note',
  答案: 'answer',
  answer: 'answer',
  解析: 'solution',
  solution: 'solution',
  来源: 'source',
  source: 'source',
  标签: 'tag',
  tag: 'tag',
  学科: 'subject',
  subject: 'subject',
  学段: 'stage',
  stage: 'stage',
  状态: 'status',
  status: 'status',
  学生: 'student',
  student: 'student',
  创建: 'created',
  created: 'created',
  修改: 'updated',
  updated: 'updated',
  有: 'has',
  has: 'has',
  范围: 'in',
  in: 'in',
};

/** 补全用的说明 */
export const KEY_HINT: Record<ReservedKey, string> = {
  title: '在标题中查找',
  content: '在题干/正文中查找',
  note: '在笔记中查找',
  answer: '在答案中查找',
  solution: '在解析中查找',
  source: '在来源备注中查找',
  tag: '标签（含下级）；无 = 没有标签',
  subject: '学科；无 = 未设置',
  stage: '学段；无 = 未设置',
  status: '资料的整理状态：待整理 / 已整理',
  student: '学生[/做过|没做|错过|最近错]',
  created: '添加日期：2026-09、>=2026-09-01、本周、7天',
  updated: '修改日期：同“创建”',
  has: '有 答案 / 解析 / 笔记 / 图片 / 标签 / 来源 / 标题 / 某个属性',
  in: '自由词只在这些范围里找：标题 正文 笔记 答案 解析 来源 标签 属性',
};

export const PROP_PREFIXES = ['prop.', '属性.'];

export function reservedKey(raw: string): ReservedKey | undefined {
  return ALIASES[nameKey(raw)];
}

export const TEXT_KEY_FIELD: Record<TextKey, SearchField> = {
  title: 'title',
  content: 'content',
  note: 'note',
  answer: 'answer',
  solution: 'solution',
  source: 'source',
};

export const IN_VALUES: Record<string, SearchField> = {
  标题: 'title',
  title: 'title',
  正文: 'content',
  题干: 'content',
  content: 'content',
  笔记: 'note',
  note: 'note',
  答案: 'answer',
  answer: 'answer',
  解析: 'solution',
  solution: 'solution',
  来源: 'source',
  source: 'source',
  标签: 'tag',
  tag: 'tag',
  属性: 'property',
  property: 'property',
};

export const FIELD_LABEL: Record<SearchField, string> = {
  title: '标题',
  content: '正文',
  note: '笔记',
  answer: '答案',
  solution: '解析',
  source: '来源',
  tag: '标签',
  property: '属性',
};

export type HasWhat = 'answer' | 'solution' | 'note' | 'image' | 'tag' | 'source' | 'title';
export const HAS_VALUES: Record<string, HasWhat> = {
  答案: 'answer',
  answer: 'answer',
  解析: 'solution',
  solution: 'solution',
  笔记: 'note',
  note: 'note',
  图片: 'image',
  image: 'image',
  标签: 'tag',
  tag: 'tag',
  来源: 'source',
  source: 'source',
  标题: 'title',
  title: 'title',
};
export const HAS_LABEL: Record<HasWhat, string> = { answer: '答案', solution: '解析', note: '笔记', image: '图片', tag: '标签', source: '来源', title: '标题' };

export const STATUS_VALUES: Record<string, MaterialStatus> = { 待整理: 'inbox', inbox: 'inbox', 已整理: 'active', active: 'active' };
export const STATUS_LABEL: Record<MaterialStatus, string> = { inbox: '待整理', active: '已整理' };

export const STUDENT_STATES: Record<string, AttemptFilter> = {
  做过: 'done',
  done: 'done',
  没做: 'none',
  没做过: 'none',
  none: 'none',
  错过: 'wrong-ever',
  做错过: 'wrong-ever',
  wrong: 'wrong-ever',
  最近错: 'wrong-last',
  last: 'wrong-last',
};
export const STUDENT_STATE_LABEL: Record<AttemptFilter, string> = { done: '做过', none: '没做', 'wrong-ever': '错过', 'wrong-last': '最近错' };

/** “未设置”与“已设置”的写法 */
export const NONE_WORDS = new Set(['无', 'none', '未设置']);
export const ANY_WORDS = new Set(['*', '任意', 'any']);
export const TRUE_WORDS = new Set(['是', 'true', 'yes', '1', '已勾选']);
export const FALSE_WORDS = new Set(['否', 'false', 'no', '0', '未勾选']);

/** 相关度的字段权重 */
export const FIELD_WEIGHT: Record<SearchField, number> = { title: 8, tag: 5, property: 5, content: 3, answer: 2, solution: 2, note: 2, source: 1 };
