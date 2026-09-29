/** 笔记分栏（笔记 / 解析 / 答案）当前选中哪一栏：优先指定的类型，其次上次用过的，再次第一个非空的类型。 */
import { NOTE_TAB_ORDER, NOTE_TYPES, type NoteType } from '@shared/constants';

const KEY = 'sworks.notes.tab';

function readLast(): NoteType | null {
  try {
    const v = localStorage.getItem(KEY);
    return NOTE_TYPES.includes(v as NoteType) ? (v as NoteType) : null;
  } catch {
    return null;
  }
}

export function rememberNoteTab(t: NoteType): void {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // 无痕模式等情况下读写失败，不影响使用
  }
}

export function initialNoteTab(notes: readonly { type: NoteType }[], preferred?: NoteType | null): NoteType {
  const has = (t: NoteType) => notes.some((n) => n.type === t);
  if (preferred && has(preferred)) return preferred;
  const last = readLast();
  if (last && has(last)) return last;
  return NOTE_TAB_ORDER.find(has) ?? last ?? NOTE_TAB_ORDER[0]!;
}
