/** 教案的小入口：题目多选后“组成教案”，题目页上的“用在这些教案里”。 */
import { ChevronDown, NotebookPen } from 'lucide-react';
import { MAX_LESSON_ITEMS, type LessonAddItemsResultDTO, type LessonListItemDTO, type SaveResult, type LessonDTO } from '@shared/api';
import { errorMessage, sendJSON } from '../../lib/api';
import { formatTime, newId } from '../../lib/format';
import { useLessons, useProblemLessons } from '../../lib/queries';
import { invalidateWrites } from '../../lib/queryClient';
import { Link, useRouter } from '../../lib/router';
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger } from '../Menu';
import { useToast } from '../ui';

/** 下拉里列出的最近修改的教案数。 */
const RECENT_LESSONS = 15;

/** 题目多选后：用所选题目新建一份教案（按勾选的顺序），或加到已有教案的末尾。 */
export function BatchLessonMenu({ ids }: { ids: string[] }) {
  const { navigate } = useRouter();
  const toast = useToast();
  const lessons = useLessons();
  const tooMany = ids.length > MAX_LESSON_ITEMS;

  const create = async () => {
    const lid = newId();
    try {
      await sendJSON<SaveResult<LessonDTO>>('POST', '/api/lessons', { id: lid, items: ids.map((problemId) => ({ problemId })) });
      invalidateWrites({ lessons: [lid] });
      toast(`已用 ${ids.length} 道题新建教案`, 'success');
      navigate(`/lessons/${lid}`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const addTo = async (l: LessonListItemDTO) => {
    const name = l.title ?? '未命名教案';
    try {
      const r = await sendJSON<LessonAddItemsResultDTO>('POST', `/api/lessons/${l.id}/items`, { problemIds: ids });
      invalidateWrites({ lessons: [l.id] });
      toast(
        r.added ? `已加入“${name}”：${r.added} 道${r.existing ? `，另有 ${r.existing} 道已在其中` : ''}` : `所选的题都已在“${name}”中`,
        'success',
        { label: '打开教案', onClick: () => navigate(`/lessons/${l.id}`) },
      );
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <button type="button" className="btn btn-sm" data-testid="batch-lesson">
          <NotebookPen size={14} /> 组成教案 <ChevronDown size={13} />
        </button>
      </DropdownTrigger>
      <DropdownContent>
        <DropdownItem disabled={tooMany} onSelect={() => void create()}>
          {tooMany ? `一份教案最多 ${MAX_LESSON_ITEMS} 道题` : `新建教案（${ids.length} 道题，按勾选顺序）`}
        </DropdownItem>
        {lessons.data?.length ? (
          <>
            <DropdownSeparator />
            <DropdownLabel>加到已有教案的末尾</DropdownLabel>
            {lessons.data.slice(0, RECENT_LESSONS).map((l) => (
              <DropdownItem key={l.id} onSelect={() => void addTo(l)}>
                <span className={`flex-1 truncate ${l.title ? '' : 'italic'}`}>{l.title ?? '未命名教案'}</span>
                <span className="text-xs text-ink-faint">{l.problemCount} 题</span>
              </DropdownItem>
            ))}
          </>
        ) : null}
      </DropdownContent>
    </DropdownMenu>
  );
}

/** 题目页：引用了这道题的教案（没有时不显示）。 */
export function ProblemLessons({ problemId, enabled }: { problemId: string; enabled: boolean }) {
  const q = useProblemLessons(problemId, enabled);
  if (!q.data?.length) return null;
  return (
    <section aria-labelledby="problem-lessons-h" className="space-y-2" data-testid="problem-lessons">
      <h2 id="problem-lessons-h" className="text-lg font-semibold text-stone">
        用在这些教案里
      </h2>
      <ul className="space-y-1 text-sm">
        {q.data.map((l) => (
          <li key={l.id}>
            <Link to={`/lessons/${l.id}`} className={`link-btn ${l.title ? '' : 'italic'}`}>
              {l.title ?? '未命名教案'}
            </Link>
            <span className="ml-2 text-xs text-ink-faint">
              {l.problemCount} 道题 · 修改于 {formatTime(l.updatedAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
