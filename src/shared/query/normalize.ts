/**
 * 检索用的文本规范化：逐码点 NFKC（全角转半角、兼容字符拆开）+ 小写 + 折叠空白（含全角空格、换行）并去掉首尾空白。
 * 检索投影与查询词用同一个函数，所以“ＡＢＣ”“abc”、跨换行的短语都能命中。
 * normalizeWithMap 同时给出每个规范化字符在原文里的位置，用来把命中区间映射回原文（高亮片段）。
 */

export interface NormMap {
  norm: string;
  /** norm 的第 i 个 UTF-16 单元来自原文 [starts[i], ends[i]) */
  starts: number[];
  ends: number[];
}

const WS = /\s/u;

function normCodePoint(ch: string): string {
  return ch.normalize('NFKC').toLowerCase();
}

export function normalizeWithMap(text: string): NormMap {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSpace = -1; // 待输出的空白在原文中的起点
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const n = normCodePoint(text.slice(i, i + len));
    for (const c of n) {
      if (WS.test(c)) {
        if (pendingSpace < 0) pendingSpace = i;
        continue;
      }
      if (pendingSpace >= 0 && out.length > 0) {
        out.push(' ');
        starts.push(pendingSpace);
        ends.push(i);
      }
      pendingSpace = -1;
      for (let k = 0; k < c.length; k++) {
        out.push(c[k]!);
        starts.push(i);
        ends.push(i + len);
      }
    }
    i += len;
  }
  return { norm: out.join(''), starts, ends };
}

/** 只要规范化结果（检索投影、查询词）。 */
export function normText(text: string): string {
  let out = '';
  let space = false;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const n = normCodePoint(text.slice(i, i + len));
    for (const c of n) {
      if (WS.test(c)) {
        space = true;
        continue;
      }
      if (space && out) out += ' ';
      space = false;
      out += c;
    }
    i += len;
  }
  return out;
}

/** 把规范化文本里的区间 [a, b) 换算为原文区间。 */
export function toOriginalRange(m: NormMap, a: number, b: number): [number, number] {
  return [m.starts[a]!, m.ends[b - 1]!];
}

/** 键名、选项名、学生名等短名称的比较键。 */
export function nameKey(s: string): string {
  return normText(s);
}
