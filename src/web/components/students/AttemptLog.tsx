/**
 * 题目页的“作答记录”：这道题所有学生的作答流水，以及快速记录。
 * 记录立即保存，与整题的“保存”互不相关；只有服务端确认后才提示“已记录”，失败时表单内容保留。
 */
import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { FELT_DIFFICULTY_LABELS } from '@shared/constants';
import { errorMessage, sendJSON } from '../../lib/api';
import { formatTime, newId } from '../../lib/format';
import { useProblemAttempts } from '../../lib/queries';
import { invalidateWrites } from '../../lib/queryClient';
import { Link } from '../../lib/router';
import { Spinner, useToast } from '../ui';
import { AttemptForm, attemptPayload } from './AttemptForm';
import { ResultChip } from './AttemptBits';

export function AttemptLog({ problemId, disabled }: { problemId: string; disabled?: boolean }) {
  const toast = useToast();
  const attempts = useProblemAttempts(problemId, !disabled);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const remove = async (id: string) => {
    try {
      await sendJSON('POST', `/api/attempts/${id}/delete`);
      invalidateWrites();
      toast('已删除这条作答记录', 'info', {
        label: '撤销',
        onClick: () => {
          void sendJSON('POST', `/api/attempts/${id}/restore`).then(() => invalidateWrites());
        },
      });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="space-y-3">
      {disabled ? (
        <p className="text-sm text-ink-faint">先保存这道题，再记录学生的作答。</p>
      ) : (
        <div className="card-flat px-4 py-3">
          <AttemptForm
            submitLabel="记录"
            busy={busy}
            onSubmit={async (v) => {
              setBusy(true);
              setSaved(null);
              try {
                await sendJSON('POST', '/api/attempts', { id: newId(), problemId, ...attemptPayload(v) });
                invalidateWrites();
                setSaved(new Date().toLocaleTimeString('zh-CN', { hour12: false }));
                return true;
              } catch (err) {
                toast(`记录失败：${errorMessage(err)}（内容仍在表单中）`, 'error');
                return false;
              } finally {
                setBusy(false);
              }
            }}
          />
          {saved ? (
            <p className="mt-1 text-xs font-semibold text-sage-deep" data-testid="attempt-saved">
              已记录 {saved}
            </p>
          ) : null}
        </div>
      )}
      {attempts.isPending && !disabled ? <Spinner /> : null}
      {attempts.data?.length ? (
        <ul className="space-y-1.5" aria-label="作答记录">
          {attempts.data.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 border-b border-line/70 pb-1.5 text-sm">
              <span className="w-28 flex-none text-xs text-ink-faint">{formatTime(a.attemptedAt)}</span>
              <Link to={`/students/${a.studentId}`} className="font-semibold text-stone hover:underline">
                {a.studentName}
              </Link>
              <ResultChip result={a.result} />
              {a.feltDifficulty ? <span className="chip chip-stone">觉得{FELT_DIFFICULTY_LABELS[a.feltDifficulty]}</span> : null}
              {a.note ? <span className="min-w-0 flex-1 truncate text-ink-soft">{a.note}</span> : <span className="flex-1" />}
              <button type="button" className="btn btn-ghost btn-sm btn-icon hover:!text-terracotta" aria-label="删除这条作答记录" onClick={() => void remove(a.id)}>
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : attempts.data && !disabled ? (
        <p className="text-sm text-ink-faint">还没有作答记录。</p>
      ) : null}
    </div>
  );
}
