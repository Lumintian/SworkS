/** 作答相关的小部件：结果标签、列表行上的作答摘要。 */
import type { AttemptSummaryDTO } from '@shared/api';
import { ATTEMPT_RESULT_LABELS, FELT_DIFFICULTY_LABELS, type AttemptResult } from '@shared/constants';
import { formatTime } from '../../lib/format';

const RESULT_CLASS: Record<AttemptResult, string> = {
  correct: 'chip',
  partial: 'chip chip-warn',
  wrong: 'chip chip-danger',
  blank: 'chip chip-danger',
};

export function ResultChip({ result }: { result: AttemptResult }) {
  return <span className={RESULT_CLASS[result]}>{ATTEMPT_RESULT_LABELS[result]}</span>;
}

/** 列表行：当前学生在这道题上的情况。 */
export function AttemptBadge({ summary, studentName }: { summary: AttemptSummaryDTO | null | undefined; studentName?: string | undefined }) {
  if (summary === undefined) return null;
  if (summary === null) return <span className="chip chip-stone" data-testid="attempt-badge">{studentName ? `${studentName} 未做过` : '未做过'}</span>;
  const parts = [`做过 ${summary.count} 次`];
  if (summary.wrong) parts.push(`错 ${summary.wrong} 次`);
  if (summary.partial) parts.push(`半对 ${summary.partial} 次`);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="attempt-badge" title={`最近一次：${formatTime(summary.lastAt)}`}>
      <span className="text-ink-soft">{parts.join(' · ')}</span>
      <span className="text-ink-faint">最近</span>
      <ResultChip result={summary.lastResult} />
      {summary.lastFelt ? <span className="chip chip-stone">觉得{FELT_DIFFICULTY_LABELS[summary.lastFelt]}</span> : null}
    </span>
  );
}
