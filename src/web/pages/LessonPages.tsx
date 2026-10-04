/**
 * 教案列表与教案编辑页。教案按引用组合题目：展开看到的是题目当前的内容，
 * 在这里只能调整顺序、写讲解要点、加题或移除；改题目本身请打开题目页。
 */
import { useQuery } from '@tanstack/react-query';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, GripVertical, Plus, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LessonDTO, LessonListItemDTO, ProblemDTO, SaveResult } from '@shared/api';
import { EntityContent } from '../components/EntityContent';
import { ChangedElsewhereBanner, ConflictDialog } from '../components/EditorExtras';
import { ProblemPicker } from '../components/lessons/ProblemPicker';
import { Popover, PopoverContent, PopoverTrigger } from '../components/Menu';
import { SaveBar, useSaveShortcut } from '../components/SaveBar';
import { EmptyState, ErrorBox, PageHeader, Spinner, useConfirm, useToast } from '../components/ui';
import { errorMessage, getJSON, sendJSON } from '../lib/api';
import { onWrite } from '../lib/broadcast';
import { formatTime, newId } from '../lib/format';
import {
  briefFromItem,
  briefFromListItem,
  emptyLessonDraft,
  lessonAsText,
  lessonDraftFromDTO,
  lessonPayload,
  type LessonDraft,
  type LessonDraftItem,
  type ProblemBrief,
} from '../lib/lessonDraft';
import { useLessons } from '../lib/queries';
import { invalidateWrites } from '../lib/queryClient';
import { Link, useLeaveGuard, useRouter } from '../lib/router';
import { useEntityEditor } from '../lib/useEntityEditor';

// ---------------------------------------------------------------- 列表

function LessonCard({ l }: { l: LessonListItemDTO }) {
  return (
    <li className="card-flat px-4 py-3" data-testid="lesson-card">
      <Link to={`/lessons/${l.id}`} className={`font-serif text-lg font-semibold hover:underline ${l.title ? 'text-stone' : 'italic text-ink-soft'}`}>
        {l.title ?? '未命名教案'}
      </Link>
      <p className="text-xs text-ink-faint">
        {l.problemCount} 道题 · 修改于 {formatTime(l.updatedAt)}
      </p>
      {l.preview.length ? (
        <p className="mt-1 truncate text-sm text-ink-soft">
          {l.preview.join(' · ')}
          {l.problemCount > l.preview.length ? ' …' : ''}
        </p>
      ) : null}
    </li>
  );
}

export function LessonsPage() {
  const { navigate } = useRouter();
  const lessons = useLessons();
  return (
    <div className="space-y-4">
      <PageHeader
        title="教案"
        subtitle="把题目按顺序组合起来。教案引用题目本身：题目改了，教案里看到的就是新内容。"
        actions={
          <button type="button" className="btn btn-primary" onClick={() => navigate(`/lessons/new?id=${newId()}`)} data-testid="new-lesson">
            <Plus size={16} /> 新建教案
          </button>
        }
      />
      {lessons.isPending ? <Spinner /> : null}
      {lessons.isError ? <ErrorBox message={errorMessage(lessons.error)} onRetry={() => void lessons.refetch()} /> : null}
      {lessons.data && lessons.data.length === 0 ? (
        <EmptyState title="还没有教案">在题目列表里勾选几道题，点“组成教案”；也可以先新建一份空教案，再逐题添加。</EmptyState>
      ) : null}
      <ul className="space-y-2">
        {lessons.data?.map((l) => (
          <LessonCard key={l.id} l={l} />
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- 编辑

/** 题目当前的完整内容（与快速预览同一个缓存）。 */
function ProblemPreview({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['entity', 'problems', id], queryFn: () => getJSON<ProblemDTO>(`/api/problems/${id}`) });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorBox message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  return <EntityContent entity={q.data} />;
}

function SortableItem({
  item,
  index,
  total,
  brief,
  open,
  onToggle,
  onNote,
  onRemove,
}: {
  item: LessonDraftItem;
  index: number;
  total: number;
  brief: ProblemBrief | undefined;
  open: boolean;
  onToggle: () => void;
  onNote: (note: string) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: item.problemId });
  const name = brief?.title ?? null;
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`card-flat px-3 py-2.5 ${isDragging ? 'relative z-10 shadow-[var(--shadow-lift)]' : ''}`}
      data-testid="lesson-item"
    >
      <div className="flex items-start gap-1.5">
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="btn btn-ghost btn-icon cursor-grab touch-none active:cursor-grabbing"
          aria-label={`拖动排序：第 ${index + 1} 题（共 ${total} 题）`}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={16} />
        </button>
        <span className="mt-1.5 min-w-[1.75rem] text-right font-serif font-semibold tabular-nums text-stone">{index + 1}.</span>
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link to={`/problems/${item.problemId}`} className={`font-semibold hover:underline ${name ? 'text-stone' : 'italic text-ink-soft'}`} data-testid="lesson-item-title">
              {name ?? '未命名题目'}
            </Link>
            {brief?.subject ? <span className="text-xs text-ink-faint">{brief.subject}</span> : null}
            {brief?.stage ? <span className="text-xs text-ink-faint">{brief.stage}</span> : null}
            {brief?.deleted ? <span className="chip chip-warn">题目在回收站</span> : null}
          </div>
          {!open && brief?.summary ? <p className="truncate text-sm text-ink-soft">{brief.summary}</p> : null}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={onToggle}>
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {open ? '收起' : '展开'}
        </button>
        <button type="button" className="btn btn-ghost btn-icon hover:!text-terracotta" aria-label={`从教案移除第 ${index + 1} 题`} onClick={onRemove}>
          <X size={16} />
        </button>
      </div>
      <div className="mt-1.5 space-y-3 md:ml-[4.25rem]">
        <textarea
          className="input min-h-[2.4rem] resize-y text-sm leading-6 [field-sizing:content]"
          rows={1}
          maxLength={4000}
          value={item.note}
          placeholder="讲解要点（可选）：这题讲什么、怎么引入…"
          aria-label={`第 ${index + 1} 题的讲解要点`}
          onChange={(e) => onNote(e.target.value)}
        />
        {open ? (
          <div className="border-t border-line pt-3" data-testid="lesson-item-preview">
            <ProblemPreview id={item.problemId} />
          </div>
        ) : null}
      </div>
    </li>
  );
}

function isLessonEmpty(d: LessonDraft): boolean {
  return !d.title.trim() && !d.note.trim() && d.items.length === 0;
}

export function LessonEditorPage({ id, isNew }: { id: string; isNew: boolean }) {
  const { navigate } = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const ed = useEntityEditor<LessonDraft, LessonDTO>({
    collection: 'lessons',
    id,
    isNew,
    empty: emptyLessonDraft,
    fromEntity: lessonDraftFromDTO,
    toPayload: lessonPayload,
    onCreated: (e) => navigate(`/lessons/${e.id}`, { replace: true, force: true }),
  });
  const { draft, setDraft } = ed;
  useLeaveGuard(() => ed.dirtyRef.current);

  // 题目的显示信息：来自教案读取结果，以及刚从选择器加入的题
  const [briefs, setBriefs] = useState<Record<string, ProblemBrief>>({});
  const loaded = ed.entity;
  useEffect(() => {
    if (loaded) setBriefs((cur) => ({ ...cur, ...Object.fromEntries(loaded.items.map((i) => [i.problemId, briefFromItem(i)])) }));
  }, [loaded]);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [pickerOpen, setPickerOpen] = useState(false);
  const inLesson = useMemo(() => new Set(draft.items.map((i) => i.problemId)), [draft.items]);
  const inLessonRef = useRef(inLesson);
  inLessonRef.current = inLesson;
  // 教案里的题在别处改了（标题、进回收站…）：只刷新显示信息，不动草稿
  useEffect(
    () =>
      onWrite((ev) => {
        const scoped = ev.problems !== undefined || ev.materials !== undefined || ev.lessons !== undefined;
        if (scoped && !(ev.problems ?? []).some((p) => inLessonRef.current.has(p))) return;
        void getJSON<LessonDTO>(`/api/lessons/${id}`).then(
          (l) => setBriefs((cur) => ({ ...cur, ...Object.fromEntries(l.items.map((i) => [i.problemId, briefFromItem(i)])) })),
          () => undefined,
        );
      }),
    [id],
  );
  const allOpen = draft.items.length > 0 && draft.items.every((i) => open.has(i.problemId));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const position = (pid: UniqueIdentifier) => draft.items.findIndex((i) => i.problemId === pid) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `已拿起第 ${position(active.id)} 题。`,
    onDragOver: ({ over }) => (over ? `移到第 ${position(over.id)} 题的位置。` : '不在可放置的位置。'),
    onDragEnd: ({ over }) => (over ? `已放到第 ${position(over.id)} 题的位置。` : '已放下，顺序不变。'),
    onDragCancel: () => '已取消拖动，顺序不变。',
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    setDraft((d) => {
      const from = d.items.findIndex((i) => i.problemId === active.id);
      const to = d.items.findIndex((i) => i.problemId === over.id);
      return from < 0 || to < 0 ? d : { ...d, items: arrayMove(d.items, from, to) };
    });
  };

  const setNote = (pid: string, note: string) => setDraft((d) => ({ ...d, items: d.items.map((i) => (i.problemId === pid ? { ...i, note } : i)) }));
  const remove = (pid: string) => {
    const index = draft.items.findIndex((i) => i.problemId === pid);
    const item = draft.items[index];
    if (!item) return;
    setDraft((d) => ({ ...d, items: d.items.filter((i) => i.problemId !== pid) }));
    toast('已从教案移除，保存后生效（题目本身不受影响）', 'info', {
      label: '撤销',
      onClick: () =>
        setDraft((d) => (d.items.some((i) => i.problemId === pid) ? d : { ...d, items: [...d.items.slice(0, index), item, ...d.items.slice(index)] })),
    });
  };
  const toggle = (pid: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(pid)) n.delete(pid);
      else n.add(pid);
      return n;
    });

  const canSave = ed.phase === 'ready' && (ed.dirty || ed.saveState.kind === 'error') && !(ed.isNew() && isLessonEmpty(draft));
  const doSave = useCallback(async () => {
    if (!canSave) return;
    await ed.save();
  }, [canSave, ed]);
  useSaveShortcut(() => void doSave());

  if (ed.phase === 'loading') return <Spinner />;
  if (ed.phase === 'error') return <ErrorBox message={ed.loadError ?? '加载失败'} onRetry={() => void ed.reload()} />;
  const entity = ed.entity;
  const deleted = Boolean(entity?.deletedAt);

  return (
    <div data-testid="lesson-editor">
      <SaveBar
        title={
          <span>
            <Link to="/lessons" className="hover:text-stone">
              教案
            </Link>{' '}
            / <span className={draft.title.trim() ? 'text-ink' : 'italic'}>{ed.isNew() ? '新建教案' : draft.title.trim() || '未命名教案'}</span>
            {entity ? <span className="ml-3 hidden text-xs text-ink-faint lg:inline">建于 {formatTime(entity.createdAt)} · 修改于 {formatTime(entity.updatedAt)}</span> : null}
          </span>
        }
        state={ed.saveState}
        dirty={ed.dirty}
        canSave={canSave && !deleted}
        onSave={() => void doSave()}
        actions={
          !ed.isNew() && entity && !deleted ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm hover:!text-terracotta"
              onClick={async () => {
                if (!(await confirm({ title: '移到回收站', message: '把这份教案移到回收站？其中的题目不受影响。', confirmLabel: '移到回收站', danger: true }))) return;
                try {
                  await sendJSON('DELETE', `/api/lessons/${id}`);
                  invalidateWrites({ lessons: [id] });
                  toast('已移到回收站', 'info');
                  navigate('/lessons', { force: true });
                } catch (err) {
                  toast(errorMessage(err), 'error');
                }
              }}
            >
              <Trash2 size={15} /> 删除
            </button>
          ) : null
        }
      />
      {ed.changedElsewhere ? <ChangedElsewhereBanner noun="份教案" example="例如从题目列表加入了题目" onReload={() => void ed.reload()} /> : null}
      {deleted ? (
        <div className="mb-4">
          <ErrorBox message="这份教案在回收站中，恢复后才能编辑。" />
          <button
            type="button"
            className="btn btn-sage mt-2"
            onClick={async () => {
              try {
                await sendJSON('POST', `/api/lessons/${id}/restore`);
                invalidateWrites({ lessons: [id] });
                await ed.reload();
                toast('已恢复', 'success');
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            }}
          >
            恢复这份教案
          </button>
        </div>
      ) : null}

      <div className="space-y-6" inert={deleted || undefined}>
        <div className="space-y-2">
          <input
            className="w-full border-0 border-b border-transparent bg-transparent px-0 py-1 font-serif text-2xl font-semibold text-stone placeholder:font-normal placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
            value={draft.title}
            maxLength={300}
            placeholder="教案标题，例如：二次函数 · 第 3 讲"
            aria-label="教案标题"
            onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
          />
          <textarea
            className="input min-h-[3rem] resize-y leading-6 [field-sizing:content]"
            rows={2}
            maxLength={20000}
            value={draft.note}
            placeholder="说明（可选）：本节目标、上课安排、给谁用…"
            aria-label="教案说明"
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          />
        </div>

        <section aria-labelledby="lesson-items-h" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="lesson-items-h" className="text-lg font-semibold text-stone">
              题目{draft.items.length ? `（${draft.items.length}）` : ''}
            </h2>
            <span className="flex-1" />
            {draft.items.length ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(allOpen ? new Set() : new Set(draft.items.map((i) => i.problemId)))}>
                {allOpen ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />} {allOpen ? '全部收起' : '全部展开'}
              </button>
            ) : null}
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <button type="button" className="btn btn-sage btn-sm" data-testid="lesson-add-problem">
                  <Plus size={15} /> 添加题目
                </button>
              </PopoverTrigger>
              <PopoverContent align="end">
                <ProblemPicker
                  exclude={inLesson}
                  onPick={(it) => {
                    setBriefs((cur) => ({ ...cur, [it.id]: briefFromListItem(it) }));
                    setDraft((d) => (d.items.some((i) => i.problemId === it.id) ? d : { ...d, items: [...d.items, { problemId: it.id, note: '' }] }));
                  }}
                />
              </PopoverContent>
            </Popover>
          </div>
          {draft.items.length === 0 ? (
            <p className="text-sm text-ink-soft">还没有题目。点“添加题目”搜索加入，或在题目列表里勾选几道题后点“组成教案 → 加入已有教案”。</p>
          ) : null}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            onDragEnd={onDragEnd}
            accessibility={{
              announcements,
              screenReaderInstructions: { draggable: '按空格或回车拿起，用上下方向键移动，再按空格或回车放下；按 Esc 取消。' },
            }}
          >
            <SortableContext items={draft.items.map((i) => i.problemId)} strategy={verticalListSortingStrategy}>
              <ol className="space-y-2" aria-label="教案中的题目">
                {draft.items.map((it, i) => (
                  <SortableItem
                    key={it.problemId}
                    item={it}
                    index={i}
                    total={draft.items.length}
                    brief={briefs[it.problemId]}
                    open={open.has(it.problemId)}
                    onToggle={() => toggle(it.problemId)}
                    onNote={(note) => setNote(it.problemId, note)}
                    onRemove={() => remove(it.problemId)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        </section>
      </div>

      <ConflictDialog
        open={ed.conflict !== null}
        message={ed.conflict?.message ?? ''}
        noun="教案"
        onClose={ed.dismissConflict}
        onReload={() => void ed.reload()}
        onSaveAsNew={async () => {
          const nid = newId();
          try {
            await sendJSON<SaveResult<LessonDTO>>('POST', '/api/lessons', { id: nid, ...lessonPayload(draft) });
            invalidateWrites({ lessons: [nid] });
            navigate(`/lessons/${nid}`, { force: true });
          } catch (err) {
            toast(errorMessage(err), 'error');
          }
        }}
        onCopy={() => {
          void navigator.clipboard.writeText(lessonAsText(draft, briefs)).then(
            () => toast('已复制到剪贴板', 'success'),
            () => toast('复制失败，请手动选择内容复制', 'error'),
          );
        }}
      />
    </div>
  );
}
