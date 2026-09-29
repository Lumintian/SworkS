import { describe, expect, it } from 'vitest';
import type { NoteType } from '@shared/constants';
import { isSeqOrdered, permuteWithinType, placeBySeq, sortBySeq } from '../../src/web/lib/noteOrder';

const n = (id: string, type: NoteType, seq: number | null = null) => ({ id, type, seq });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('同类型内拖动', () => {
  it('只在该类型已占用的位置之间重排，其他类型原位不动', () => {
    const notes = [n('a1', 'answer'), n('s1', 'solution'), n('a2', 'answer'), n('x', 'note'), n('a3', 'answer')];
    expect(ids(permuteWithinType(notes, 'answer', 'a3', 'a1'))).toEqual(['a3', 's1', 'a1', 'x', 'a2']);
    expect(ids(permuteWithinType(notes, 'answer', 'a1', 'a3'))).toEqual(['a2', 's1', 'a3', 'x', 'a1']);
  });

  it('找不到或原地放下时返回同样的顺序（新数组）', () => {
    const notes = [n('a1', 'answer'), n('a2', 'answer')];
    const same = permuteWithinType(notes, 'answer', 'a1', 'a1');
    expect(same).not.toBe(notes);
    expect(ids(same)).toEqual(['a1', 'a2']);
    expect(ids(permuteWithinType(notes, 'answer', 'zz', 'a1'))).toEqual(['a1', 'a2']);
  });
});

describe('填写序号后自动归位', () => {
  it('放到第一个序号 ≥ 新序号的笔记之前（用户示例：给第 3 条填 3，留在 (2) 之后）', () => {
    const notes = [n('p1', 'answer', 1), n('p2', 'answer', 2), n('u', 'answer', 3), n('p3', 'answer', 3)];
    expect(ids(placeBySeq(notes, 'u'))).toEqual(['p1', 'p2', 'u', 'p3']);
  });

  it('从末尾移到中间；无序号的笔记跟着相对位置走', () => {
    const notes = [n('p1', 'answer', 1), n('free', 'answer'), n('p3', 'answer', 3), n('x', 'answer', 2)];
    expect(ids(placeBySeq(notes, 'x'))).toEqual(['p1', 'free', 'x', 'p3']);
  });

  it('比所有序号都大：放到最后一个带序号的之后；同类型没有其他序号时不动', () => {
    const notes = [n('x', 'answer', 9), n('p1', 'answer', 1), n('free', 'answer')];
    expect(ids(placeBySeq(notes, 'x'))).toEqual(['p1', 'x', 'free']);
    const lonely = [n('free', 'answer'), n('x', 'answer', 5)];
    expect(ids(placeBySeq(lonely, 'x'))).toEqual(['free', 'x']);
  });

  it('只在同类型内移动，其他类型的位置不变', () => {
    const notes = [n('s', 'solution', 1), n('a2', 'answer', 2), n('nn', 'note'), n('a1', 'answer', 1)];
    expect(ids(placeBySeq(notes, 'a1'))).toEqual(['s', 'a1', 'nn', 'a2']);
  });

  it('清除序号（null）时不动', () => {
    const notes = [n('a', 'answer', 2), n('b', 'answer')];
    expect(ids(placeBySeq(notes, 'b'))).toEqual(['a', 'b']);
  });
});

describe('按序号重排', () => {
  it('带序号的在它们所占的位置里稳定排序，无序号的原位不动', () => {
    const notes = [n('c', 'answer', 3), n('free', 'answer'), n('a', 'answer', 1), n('s', 'solution', 0), n('b', 'answer', 2), n('b2', 'answer', 2)];
    expect(isSeqOrdered(notes, 'answer')).toBe(false);
    const sorted = sortBySeq(notes, 'answer');
    expect(ids(sorted)).toEqual(['a', 'free', 'b', 's', 'b2', 'c']);
    expect(isSeqOrdered(sorted, 'answer')).toBe(true);
    expect(isSeqOrdered(notes, 'solution')).toBe(true);
  });
});
