/**
 * 笔记排序的纯函数。笔记在草稿里是一个全局数组（保存时数组下标即 position），
 * 界面按类型分栏显示；这里的操作都只在某一类型已占用的数组位置之间重排，其他类型保持原位，
 * 因此切换或重排一个类型不会让别的类型“看起来有变化”。
 */
import type { NoteType } from '@shared/constants';

export interface OrderedNote {
  id: string;
  type: NoteType;
  seq: number | null;
}

/** 满足条件的笔记在全局数组中的下标（升序）。 */
function slots<T>(notes: readonly T[], pred: (n: T) => boolean): number[] {
  const out: number[] = [];
  notes.forEach((n, i) => {
    if (pred(n)) out.push(i);
  });
  return out;
}

/** 把 group 依次放回 slotIdx 所指的位置。 */
function refill<T>(notes: readonly T[], slotIdx: readonly number[], group: readonly T[]): T[] {
  const out = [...notes];
  slotIdx.forEach((slot, k) => {
    out[slot] = group[k]!;
  });
  return out;
}

function arrayMove<T>(xs: readonly T[], from: number, to: number): T[] {
  const out = [...xs];
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x!);
  return out;
}

/** 同类型内拖动：把 activeId 移到 overId 的位置（与 dnd-kit 的 arrayMove 语义相同）。 */
export function permuteWithinType<T extends OrderedNote>(notes: readonly T[], type: NoteType, activeId: string, overId: string): T[] {
  const idx = slots(notes, (n) => n.type === type);
  const group = idx.map((i) => notes[i]!);
  const from = group.findIndex((n) => n.id === activeId);
  const to = group.findIndex((n) => n.id === overId);
  if (from < 0 || to < 0 || from === to) return [...notes];
  return refill(notes, idx, arrayMove(group, from, to));
}

/**
 * 填写或修改序号后自动归位（只在同类型内移动）：
 * 放到同类型中第一个“序号 ≥ 新序号”的其他笔记之前；没有则放到最后一个带序号的笔记之后；
 * 同类型没有其他带序号的笔记时不动。
 */
export function placeBySeq<T extends OrderedNote>(notes: readonly T[], id: string): T[] {
  const target = notes.find((n) => n.id === id);
  if (!target || target.seq === null) return [...notes];
  const s = target.seq;
  const idx = slots(notes, (n) => n.type === target.type);
  const group = idx.map((i) => notes[i]!);
  const rest = group.filter((n) => n.id !== id);
  let at = rest.findIndex((n) => n.seq !== null && n.seq >= s);
  if (at < 0) {
    let last = -1;
    rest.forEach((n, i) => {
      if (n.seq !== null) last = i;
    });
    if (last < 0) return [...notes];
    at = last + 1;
  }
  const next = [...rest.slice(0, at), target, ...rest.slice(at)];
  return refill(notes, idx, next);
}

/** 带序号的笔记是否已按序号排列（同类型内，只看带序号的）。 */
export function isSeqOrdered(notes: readonly OrderedNote[], type: NoteType): boolean {
  let prev = -Infinity;
  for (const n of notes) {
    if (n.type !== type || n.seq === null) continue;
    if (n.seq < prev) return false;
    prev = n.seq;
  }
  return true;
}

/** 按序号重排：带序号的笔记在它们所占的位置里按序号稳定排序，不带序号的原位不动。 */
export function sortBySeq<T extends OrderedNote>(notes: readonly T[], type: NoteType): T[] {
  const idx = slots(notes, (n) => n.type === type && n.seq !== null);
  const group = idx.map((i) => notes[i]!).sort((a, b) => a.seq! - b.seq!);
  return refill(notes, idx, group);
}
