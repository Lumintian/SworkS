/** 教案编辑页的草稿：标题、说明与按顺序引用的题目（各带讲解要点）。 */
import type { LessonDTO, LessonItemDTO, ListItemDTO } from '@shared/api';

export interface LessonDraftItem {
  problemId: string;
  note: string;
}

export interface LessonDraft {
  title: string;
  note: string;
  items: LessonDraftItem[];
}

/** 题目在教案里显示用的简要信息（来自教案读取结果或题目列表）。 */
export interface ProblemBrief {
  title: string | null;
  summary: string;
  subject: string | null;
  stage: string | null;
  deleted: boolean;
}

export const emptyLessonDraft = (): LessonDraft => ({ title: '', note: '', items: [] });

export function lessonDraftFromDTO(l: LessonDTO): LessonDraft {
  return {
    title: l.title ?? '',
    note: l.note ?? '',
    items: l.items.map((i) => ({ problemId: i.problemId, note: i.note ?? '' })),
  };
}

const short = (v: string) => (v.trim() === '' ? null : v.trim());

/** 保存载荷；与服务端的规范化一致（去首尾空白、空串为 null），保存后不会误判为“有未保存的修改”。 */
export function lessonPayload(d: LessonDraft) {
  return {
    title: short(d.title),
    note: short(d.note),
    items: d.items.map((i) => ({ problemId: i.problemId, note: short(i.note) })),
  };
}

export function briefFromItem(i: LessonItemDTO): ProblemBrief {
  return { title: i.title, summary: i.summary, subject: i.subject, stage: i.stage, deleted: i.deleted };
}

export function briefFromListItem(i: ListItemDTO): ProblemBrief {
  return { title: i.title, summary: i.summary, subject: i.subject, stage: i.stage, deleted: false };
}

/** 冲突时“复制内容”：标题、说明与题目清单（含讲解要点）。 */
export function lessonAsText(d: LessonDraft, briefs: Record<string, ProblemBrief>): string {
  const lines = [d.title.trim() || '未命名教案'];
  if (d.note.trim()) lines.push('', d.note.trim());
  lines.push('');
  d.items.forEach((it, i) => {
    const b = briefs[it.problemId];
    lines.push(`${i + 1}. ${b?.title ?? (b?.summary || '未命名题目')}`);
    if (it.note.trim()) lines.push(`   讲解要点：${it.note.trim()}`);
  });
  return lines.join('\n');
}
