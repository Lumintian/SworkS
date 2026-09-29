/**
 * 日期条件：`2026`、`2026-09`、`2026-09-01`、今天/昨天/本周/本月/今年、`7天`（含今天在内的最近 7 天），
 * 比较符（`>=2026-09-01`）与区间（`2026-09..2026-10`）。按本机时区的自然日换算边界。
 * 条件保存为原样的写法（DateSpec），执行时才按当前时间换算，所以常用检索里的“本周”一直是本周。
 */

export type CmpOp = '>=' | '<=' | '>' | '<' | '=';

export type DateSpec = { kind: 'cmp'; op: CmpOp; v: string } | { kind: 'range'; lo: string | null; hi: string | null };

const RELATIVE: Record<string, string> = {
  今天: 'today',
  today: 'today',
  昨天: 'yesterday',
  yesterday: 'yesterday',
  本周: 'week',
  thisweek: 'week',
  上周: 'lastweek',
  lastweek: 'lastweek',
  本月: 'month',
  thismonth: 'month',
  上月: 'lastmonth',
  lastmonth: 'lastmonth',
  今年: 'year',
  thisyear: 'year',
};

export const DATE_SHORTCUTS = ['今天', '昨天', '本周', '上周', '本月', '上月', '今年', '7天', '30天'];

const day = (y: number, m: number, d: number) => new Date(y, m, d);

/** 一个日期词对应的本地时间区间 [start, end)；无法识别时返回 null。 */
export function termRange(term: string, now: Date = new Date()): [Date, Date] | null {
  const t = term.trim().toLowerCase();
  const y = now.getFullYear();
  const mo = now.getMonth();
  const d = now.getDate();
  const rel = RELATIVE[t];
  if (rel) {
    switch (rel) {
      case 'today':
        return [day(y, mo, d), day(y, mo, d + 1)];
      case 'yesterday':
        return [day(y, mo, d - 1), day(y, mo, d)];
      case 'week':
      case 'lastweek': {
        const monday = d - ((now.getDay() + 6) % 7) - (rel === 'lastweek' ? 7 : 0);
        return [day(y, mo, monday), day(y, mo, monday + 7)];
      }
      case 'month':
        return [day(y, mo, 1), day(y, mo + 1, 1)];
      case 'lastmonth':
        return [day(y, mo - 1, 1), day(y, mo, 1)];
      case 'year':
        return [day(y, 0, 1), day(y + 1, 0, 1)];
    }
  }
  const lastN = /^(\d{1,4})\s*(天|d|days?)$/.exec(t);
  if (lastN) {
    const n = Number(lastN[1]);
    if (n < 1) return null;
    return [day(y, mo, d - n + 1), day(y, mo, d + 1)];
  }
  const m = /^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/.exec(t);
  if (!m) return null;
  const yy = Number(m[1]);
  if (m[2] === undefined) return [day(yy, 0, 1), day(yy + 1, 0, 1)];
  const mm = Number(m[2]) - 1;
  if (mm < 0 || mm > 11) return null;
  if (m[3] === undefined) return [day(yy, mm, 1), day(yy, mm + 1, 1)];
  const dd = Number(m[3]);
  const start = day(yy, mm, dd);
  if (start.getMonth() !== mm || start.getDate() !== dd) return null;
  return [start, day(yy, mm, dd + 1)];
}

export function isValidDateTerm(term: string): boolean {
  return termRange(term, new Date(2000, 0, 1)) !== null;
}

/** 条件的时间边界 [from, to)（本地时间）；无法识别时返回 null。 */
export function specBounds(spec: DateSpec, now: Date = new Date()): { from?: Date; to?: Date } | null {
  if (spec.kind === 'range') {
    const lo = spec.lo ? termRange(spec.lo, now) : null;
    const hi = spec.hi ? termRange(spec.hi, now) : null;
    if ((spec.lo && !lo) || (spec.hi && !hi)) return null;
    return { ...(lo ? { from: lo[0] } : {}), ...(hi ? { to: hi[1] } : {}) };
  }
  const r = termRange(spec.v, now);
  if (!r) return null;
  switch (spec.op) {
    case '=':
      return { from: r[0], to: r[1] };
    case '>=':
      return { from: r[0] };
    case '>':
      return { from: r[1] };
    case '<':
      return { to: r[0] };
    case '<=':
      return { to: r[1] };
  }
}

/** 本地日期的 YYYY-MM-DD（日期属性按这个比较） */
export function localDateString(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function specText(spec: DateSpec): string {
  if (spec.kind === 'range') return `${spec.lo ?? ''}..${spec.hi ?? ''}`;
  return spec.op === '=' ? spec.v : `${spec.op}${spec.v}`;
}
