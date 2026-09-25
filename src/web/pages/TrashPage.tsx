import { useCallback, useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { TrashDTO } from '@shared/api';
import { NOTE_TYPE_LABELS } from '@shared/constants';
import { EmptyState, ErrorBox, PageHeader, Spinner, useToast } from '../components/ui';
import { errorMessage, getJSON, sendJSON } from '../lib/api';
import { formatTime } from '../lib/format';
import { Link } from '../lib/router';

export function TrashPage() {
  const [data, setData] = useState<TrashDTO | null>(null);
  const [error, setError] = useState('');
  const toast = useToast();
  const load = useCallback(() => {
    setError('');
    getJSON<TrashDTO>('/api/trash').then(setData, (e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const restore = async (url: string, what: string) => {
    try {
      await sendJSON('POST', url);
      toast(`${what}已恢复`, 'success');
      load();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  if (error) return <ErrorBox message={error} onRetry={load} />;
  if (!data) return <Spinner />;
  const empty = data.problems.length + data.materials.length + data.notes.length === 0;
  return (
    <div className="space-y-6">
      <PageHeader title="回收站" subtitle="删除采用可恢复的软删除；目前不提供永久清空。删除题目不会删除其来源资料或共用图片。" />
      {empty ? <EmptyState title="回收站是空的" /> : null}
      {data.problems.length > 0 ? (
        <section className="space-y-2">
          <h2 className="font-semibold text-stone">题目</h2>
          <ul className="space-y-2">
            {data.problems.map((p) => (
              <li key={p.id} className="card-flat flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <Link to={`/problems/${p.id}`} className={`font-semibold ${p.title ? 'text-stone' : 'italic text-ink-soft'}`}>
                    {p.title ?? '未命名题目'}
                  </Link>
                  <p className="truncate text-xs text-ink-soft">{p.summary || '（无文字内容）'} · 删除于 {formatTime(p.deletedAt)}</p>
                </div>
                <button type="button" className="btn btn-sm btn-sage" onClick={() => void restore(`/api/problems/${p.id}/restore`, '题目')}>
                  <RotateCcw size={14} /> 恢复
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.notes.length > 0 ? (
        <section className="space-y-2">
          <h2 className="font-semibold text-stone">笔记 / 答案 / 解析</h2>
          <ul className="space-y-2">
            {data.notes.map((n) => (
              <li key={n.id} className="card-flat flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    <span className="chip chip-stone mr-2">{NOTE_TYPE_LABELS[n.type]}</span>
                    {n.title ?? <span className="italic text-ink-soft">无标题</span>}
                  </p>
                  <p className="truncate text-xs text-ink-soft">
                    {n.summary || '（空）'} · 所属题目：
                    <Link to={`/problems/${n.problemId}`} className="link-btn">
                      {n.problemTitle ?? '未命名题目'}
                    </Link>
                    {n.problemDeleted ? '（题目也在回收站）' : ''} · 删除于 {formatTime(n.deletedAt)}
                  </p>
                </div>
                <button type="button" className="btn btn-sm btn-sage" onClick={() => void restore(`/api/notes/${n.id}/restore`, '笔记')}>
                  <RotateCcw size={14} /> 恢复
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.materials.length > 0 ? (
        <section className="space-y-2">
          <h2 className="font-semibold text-stone">资料</h2>
          <ul className="space-y-2">
            {data.materials.map((m) => (
              <li key={m.id} className="card-flat flex flex-wrap items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <Link to={`/materials/${m.id}`} className={`font-semibold ${m.title ? 'text-stone' : 'italic text-ink-soft'}`}>
                    {m.title ?? '未命名资料'}
                  </Link>
                  <p className="truncate text-xs text-ink-soft">{m.summary || '（无文字内容）'} · 删除于 {formatTime(m.deletedAt)}</p>
                </div>
                <button type="button" className="btn btn-sm btn-sage" onClick={() => void restore(`/api/materials/${m.id}/restore`, '资料')}>
                  <RotateCcw size={14} /> 恢复
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
