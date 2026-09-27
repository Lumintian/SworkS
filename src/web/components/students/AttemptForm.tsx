/** 记录作答的表单：选学生（可当场新建）、结果、主观难度、备注、时间。编辑页与批量操作共用。 */
import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { StudentDTO } from '@shared/api';
import { ATTEMPT_RESULT_LABELS, ATTEMPT_RESULTS, FELT_DIFFICULTY_LABELS, type AttemptResult } from '@shared/constants';
import { errorMessage, sendJSON } from '../../lib/api';
import { newId } from '../../lib/format';
import { lastStudentId, rememberStudent, useStudents } from '../../lib/queries';
import { invalidateWrites } from '../../lib/queryClient';
import { useToast } from '../ui';

export interface AttemptFormValue {
  studentId: string;
  result: AttemptResult;
  feltDifficulty: number | null;
  note: string;
  /** datetime-local 的值；空表示“现在” */
  at: string;
}

function localNow(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

export function attemptPayload(v: AttemptFormValue) {
  return {
    studentId: v.studentId,
    result: v.result,
    feltDifficulty: v.feltDifficulty,
    note: v.note.trim() || null,
    ...(v.at ? { attemptedAt: new Date(v.at).toISOString() } : {}),
  };
}

export function AttemptForm({
  submitLabel,
  busy,
  onSubmit,
  compact,
}: {
  submitLabel: string;
  busy?: boolean;
  /** 返回 true 表示已保存：清空备注，保留学生与结果以便连续记录 */
  onSubmit: (v: AttemptFormValue) => Promise<boolean>;
  compact?: boolean;
}) {
  const toast = useToast();
  const students = useStudents();
  const [studentId, setStudentId] = useState<string>('');
  const [result, setResult] = useState<AttemptResult>('wrong');
  const [felt, setFelt] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [at, setAt] = useState('');
  const [newName, setNewName] = useState<string | null>(null);

  // 默认选上次记录时的学生
  useEffect(() => {
    if (studentId || !students.data?.length) return;
    const last = lastStudentId();
    setStudentId(students.data.find((s) => s.id === last)?.id ?? students.data[0]!.id);
  }, [students.data, studentId]);

  const createStudent = async () => {
    const name = newName?.trim();
    if (!name) return;
    try {
      const s = await sendJSON<StudentDTO>('POST', '/api/students', { id: newId(), name });
      invalidateWrites();
      setStudentId(s.id);
      setNewName(null);
      toast(`已新建学生“${s.name}”`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <form
      className={`space-y-2.5 text-sm ${compact ? 'w-[26rem] max-w-[92vw] p-3' : ''}`}
      aria-label="记录作答"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!studentId) return;
        rememberStudent(studentId);
        if (await onSubmit({ studentId, result, feltDifficulty: felt, note, at })) setNote('');
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        {newName === null ? (
          <>
            <select className="select w-auto min-w-[8rem] py-1" value={studentId} aria-label="学生" onChange={(e) => setStudentId(e.target.value)}>
              {students.data?.length ? null : <option value="">还没有学生</option>}
              {students.data?.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNewName('')}>
              <Plus size={14} /> 新学生
            </button>
          </>
        ) : (
          <>
            <input
              className="input w-40 py-1"
              value={newName}
              autoFocus
              maxLength={60}
              placeholder="学生姓名"
              aria-label="新学生姓名"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void createStudent();
                } else if (e.key === 'Escape') setNewName(null);
              }}
            />
            <button type="button" className="btn btn-sage btn-sm" disabled={!newName.trim()} onClick={() => void createStudent()}>
              添加学生
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setNewName(null)}>
              取消
            </button>
          </>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="label mb-0">结果</span>
        <div className="segmented" role="group" aria-label="作答结果">
          {ATTEMPT_RESULTS.map((r) => (
            <button key={r} type="button" aria-pressed={result === r} onClick={() => setResult(r)}>
              {ATTEMPT_RESULT_LABELS[r]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="label mb-0">主观难度</span>
        <div className="segmented" role="group" aria-label="主观难度">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" aria-pressed={felt === n} onClick={() => setFelt(felt === n ? null : n)}>
              {FELT_DIFFICULTY_LABELS[n]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input min-w-[10rem] flex-1 py-1"
          value={note}
          maxLength={4000}
          placeholder="备注：错因、卡在哪一步…（可选）"
          aria-label="作答备注"
          onChange={(e) => setNote(e.target.value)}
        />
        <input
          className="input w-auto py-1"
          type="datetime-local"
          value={at}
          max={localNow()}
          aria-label="作答时间（留空为现在）"
          title="留空表示现在"
          onChange={(e) => setAt(e.target.value)}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!studentId || busy} data-testid="record-attempt">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
