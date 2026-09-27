/**
 * 学生列表与学生详情：统计、薄弱考点（按考点树向上汇总）、当前错题、作答时间线、导出错题。
 */
import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Check, Download, ListFilter, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import type { ListResponse, StudentDetailDTO, StudentDTO } from '@shared/api';
import { FELT_DIFFICULTY_LABELS } from '@shared/constants';
import { EMPTY_FILTERS, listFiltersToParams } from '@shared/listFilters';
import { AttemptBadge, ResultChip } from '../components/students/AttemptBits';
import { EmptyState, ErrorBox, PageHeader, Spinner, useConfirm, useToast } from '../components/ui';
import { errorMessage, getJSON, sendJSON } from '../lib/api';
import { exportProblems } from '../lib/exportMarkdown';
import { formatTime, newId } from '../lib/format';
import { fetchAllIds, useStudentDetail, useStudents } from '../lib/queries';
import { invalidateWrites } from '../lib/queryClient';
import { Link, useRouter } from '../lib/router';
import { useCatalog } from '../lib/useCatalog';

function pct(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : '—';
}

/** 题目列表中查看某个学生的作答情况（可选按作答状态筛选）。 */
export function studentListUrl(studentId: string, attempt: '' | 'none' | 'done' | 'wrong-ever' | 'wrong-last' = ''): string {
  return `/problems?${listFiltersToParams({ ...EMPTY_FILTERS, student: studentId, attempt }).toString()}`;
}

function StudentCard({ s }: { s: StudentDTO }) {
  return (
    <li className="card-flat flex flex-wrap items-center gap-3 px-4 py-3" data-testid="student-item">
      <div className="min-w-0 flex-1">
        <Link to={`/students/${s.id}`} className="font-serif text-lg font-semibold text-stone hover:underline">
          {s.name}
        </Link>
        {s.stage ? <span className="ml-2 text-sm text-ink-faint">{s.stage}</span> : null}
        {s.archived ? <span className="chip chip-stone ml-2">已归档</span> : null}
        <p className="text-xs text-ink-faint">
          做过 {s.stats.problems} 题 · 作答 {s.stats.attempts} 次 · 正确率 {pct(s.stats.correct + s.stats.partial / 2, s.stats.attempts)}
          {s.stats.lastAttemptAt ? ` · 最近 ${formatTime(s.stats.lastAttemptAt)}` : ''}
        </p>
      </div>
      {s.stats.openMistakes ? (
        <Link to={studentListUrl(s.id, 'wrong-last')} className="chip chip-danger">
          当前错题 {s.stats.openMistakes}
        </Link>
      ) : null}
    </li>
  );
}

export function StudentsPage() {
  const toast = useToast();
  const { navigate } = useRouter();
  const [showArchived, setShowArchived] = useState(false);
  const students = useStudents(showArchived);
  const [name, setName] = useState('');
  const [stage, setStage] = useState('');
  const catalog = useCatalog();
  return (
    <div className="space-y-4">
      <PageHeader title="学生" subtitle="每次作答记一条流水；做过、错几次、主观难度与薄弱考点都由流水统计。" />
      <form
        className="card-flat flex flex-wrap items-end gap-3 px-4 py-3 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const s = await sendJSON<StudentDTO>('POST', '/api/students', { id: newId(), name: name.trim(), stage: stage.trim() || null });
            invalidateWrites();
            setName('');
            setStage('');
            toast(`已添加学生“${s.name}”`, 'success');
            navigate(`/students/${s.id}`);
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        }}
      >
        <label className="min-w-[10rem] flex-1">
          <span className="label">姓名</span>
          <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span className="label">学段 / 年级（可选）</span>
          <input className="input" list="student-stage-list" value={stage} maxLength={50} onChange={(e) => setStage(e.target.value)} />
          <datalist id="student-stage-list">
            {catalog.stages.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </label>
        <button type="submit" className="btn btn-primary" disabled={!name.trim()}>
          <Plus size={15} /> 添加学生
        </button>
      </form>
      <label className="flex items-center gap-2 text-sm text-ink-soft">
        <input type="checkbox" className="accent-[var(--color-sage-deep)]" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        显示已归档的学生
      </label>
      {students.isPending ? <Spinner /> : null}
      {students.isError ? <ErrorBox message={errorMessage(students.error)} onRetry={() => void students.refetch()} /> : null}
      {students.data && students.data.length === 0 ? <EmptyState title="还没有学生">添加学生后，就可以在题目页或题目列表中记录他们的作答。</EmptyState> : null}
      <ul className="space-y-2">
        {students.data?.map((s) => (
          <StudentCard key={s.id} s={s} />
        ))}
      </ul>
    </div>
  );
}

function EditHeader({ s }: { s: StudentDetailDTO }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.name);
  const [stage, setStage] = useState(s.stage ?? '');
  const [note, setNote] = useState(s.note ?? '');
  if (!editing) {
    return (
      <PageHeader
        title={
          <>
            {s.name}
            {s.stage ? <span className="ml-3 text-base font-normal text-ink-faint">{s.stage}</span> : null}
            {s.archived ? <span className="chip chip-stone ml-3 align-middle text-xs">已归档</span> : null}
          </>
        }
        subtitle={s.note ?? undefined}
        actions={
          <>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setName(s.name);
                setStage(s.stage ?? '');
                setNote(s.note ?? '');
                setEditing(true);
              }}
            >
              <Pencil size={14} /> 编辑
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                try {
                  await sendJSON('POST', `/api/students/${s.id}/${s.archived ? 'unarchive' : 'archive'}`);
                  invalidateWrites();
                  toast(s.archived ? '已取消归档' : '已归档：不再出现在记录作答的候选中，记录保留', 'success');
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              }}
            >
              {s.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />} {s.archived ? '取消归档' : '归档'}
            </button>
          </>
        }
      />
    );
  }
  return (
    <form
      className="card-flat mb-5 flex flex-wrap items-end gap-3 px-4 py-3 text-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await sendJSON('PUT', `/api/students/${s.id}`, { name: name.trim(), stage: stage.trim() || null, note: note.trim() || null, expectedVersion: s.version });
          invalidateWrites();
          setEditing(false);
          toast('已保存', 'success');
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      }}
    >
      <label className="min-w-[8rem] flex-1">
        <span className="label">姓名</span>
        <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span className="label">学段 / 年级</span>
        <input className="input" value={stage} maxLength={50} onChange={(e) => setStage(e.target.value)} />
      </label>
      <label className="min-w-[12rem] flex-[2]">
        <span className="label">备注</span>
        <input className="input" value={note} maxLength={4000} onChange={(e) => setNote(e.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim()}>
        <Check size={14} /> 保存
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
        <X size={14} /> 取消
      </button>
    </form>
  );
}

export function StudentPage({ id }: { id: string }) {
  const toast = useToast();
  const confirm = useConfirm();
  const detail = useStudentDetail(id);
  const catalog = useCatalog();
  const kp = catalog.properties.find((d) => d.preset === 'knowledge');
  const mistakes = useQuery({
    queryKey: ['list', 'problems', 'student-mistakes', id],
    queryFn: () => getJSON<ListResponse>(`/api/problems?${listFiltersToParams({ ...EMPTY_FILTERS, student: id, attempt: 'wrong-last' }).toString()}&limit=20`),
  });

  if (detail.isPending) return <Spinner />;
  if (detail.isError) return <ErrorBox message={errorMessage(detail.error)} onRetry={() => void detail.refetch()} />;
  const s = detail.data;
  const st = s.stats;

  const exportMistakes = async () => {
    try {
      const r = await fetchAllIds('problems', { ...EMPTY_FILTERS, student: id, attempt: 'wrong-last' });
      if (r.ids.length === 0) {
        toast('当前没有错题', 'info');
        return;
      }
      const out = await exportProblems(r.ids);
      toast(out.message, out.tone);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="space-y-6" data-testid="student-page">
      <EditHeader key={s.version} s={s} />
      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="统计">
        {[
          ['做过的题', String(st.problems)],
          ['作答次数', String(st.attempts)],
          ['正确率', pct(st.correct + st.partial / 2, st.attempts)],
          ['当前错题', String(st.openMistakes)],
        ].map(([k, v]) => (
          <div key={k} className="card-flat px-4 py-3">
            <p className="text-xs font-bold text-ink-faint">{k}</p>
            <p className="font-serif text-2xl font-semibold text-stone">{v}</p>
          </div>
        ))}
      </section>

      <section className="space-y-2" aria-labelledby="weak-h">
        <h2 id="weak-h" className="text-lg font-semibold text-stone">
          薄弱{kp?.name ?? '考点'}
        </h2>
        {s.weakPoints.length === 0 ? (
          <p className="text-sm text-ink-faint">
            {kp ? `给题目标上${kp.name}并记录作答后，这里会按${kp.name}（含上级）汇总没做对的比例；作答少于 3 次的不列出。` : '考点属性已归档。'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {s.weakPoints.map((w) => (
              <li key={w.optionId} className="grid grid-cols-[minmax(0,1fr)_8rem_auto] items-center gap-3 text-sm">
                <Link
                  to={`/problems?${listFiltersToParams({ ...EMPTY_FILTERS, student: id, props: kp ? [{ propertyId: kp.id, values: [w.optionId] }] : [] }).toString()}`}
                  className="truncate text-stone hover:underline"
                  title={w.path}
                >
                  {w.path}
                </Link>
                <span className="h-2 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
                  <span className="block h-full bg-terracotta/70" style={{ width: `${Math.round(w.missRate * 100)}%` }} />
                </span>
                <span className="text-xs text-ink-faint">
                  没做对 {Math.round(w.missRate * 100)}% · {w.attempts} 次 / {w.problems} 题
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="mistakes-h">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="mistakes-h" className="text-lg font-semibold text-stone">
            当前错题
          </h2>
          <span className="text-sm text-ink-faint">最近一次没做对的题</span>
          <Link to={studentListUrl(id, 'wrong-last')} className="btn btn-ghost btn-sm ml-auto">
            <ListFilter size={14} /> 在题目列表中查看
          </Link>
          <button type="button" className="btn btn-sage btn-sm" onClick={() => void exportMistakes()}>
            <Download size={14} /> 导出错题为 Markdown
          </button>
        </div>
        {mistakes.data?.items.length ? (
          <ul className="space-y-1.5">
            {mistakes.data.items.map((p) => (
              <li key={p.id} className="card-flat flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <Link to={`/problems/${p.id}`} className={`min-w-0 flex-1 truncate font-semibold hover:underline ${p.title ? 'text-stone' : 'italic text-ink-soft'}`}>
                  {p.title ?? (p.summary || '未命名题目')}
                </Link>
                <AttemptBadge summary={p.attempt} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-faint">{mistakes.isPending ? '加载中…' : '没有错题。'}</p>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="timeline-h">
        <div className="flex items-center gap-2">
          <h2 id="timeline-h" className="text-lg font-semibold text-stone">
            作答记录
          </h2>
          <Link to={studentListUrl(id, 'none')} className="btn btn-ghost btn-sm ml-auto">
            还没做过的题 →
          </Link>
        </div>
        {s.recentAttempts.length === 0 ? <p className="text-sm text-ink-faint">还没有作答记录。可以在题目页的“作答记录”里记录，或在题目列表里多选后批量记录。</p> : null}
        <ul className="space-y-1.5">
          {s.recentAttempts.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-2 border-b border-line/70 pb-1.5 text-sm">
              <span className="w-28 flex-none text-xs text-ink-faint">{formatTime(a.attemptedAt)}</span>
              <ResultChip result={a.result} />
              <Link to={`/problems/${a.problemId}`} className={`min-w-0 max-w-[40%] truncate hover:underline ${a.problemTitle ? 'text-stone' : 'italic text-ink-soft'}`}>
                {a.problemTitle ?? (a.problemSummary || '未命名题目')}
              </Link>
              {a.problemDeleted ? <span className="chip chip-stone">题目在回收站</span> : null}
              {a.feltDifficulty ? <span className="chip chip-stone">觉得{FELT_DIFFICULTY_LABELS[a.feltDifficulty]}</span> : null}
              <span className="min-w-0 flex-1 truncate text-ink-soft">{a.note}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm btn-icon hover:!text-terracotta"
                aria-label="删除这条作答记录"
                onClick={async () => {
                  if (!(await confirm({ title: '删除作答记录', message: '删除后不再计入统计，可以立即撤销。', confirmLabel: '删除', danger: true }))) return;
                  try {
                    await sendJSON('POST', `/api/attempts/${a.id}/delete`);
                    invalidateWrites();
                    toast('已删除', 'info', {
                      label: '撤销',
                      onClick: () => void sendJSON('POST', `/api/attempts/${a.id}/restore`).then(() => invalidateWrites()),
                    });
                  } catch (err) {
                    toast(errorMessage(err), 'error');
                  }
                }}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
