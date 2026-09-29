/**
 * 类型化笔记：按“笔记 / 解析 / 答案”分栏；栏内拖动手柄排序（也可用键盘），可填可选的序号（填写后自动归位）。
 * 草稿里所有笔记仍是一个数组（保存时数组下标即位置）；栏内的重排只在该类型已占用的位置之间进行。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDownWideNarrow, GripVertical, Plus, Trash2 } from 'lucide-react';
import { NOTE_SEQ_MAX, NOTE_TAB_ORDER, NOTE_TYPE_LABELS, NOTE_TYPES, type NoteType } from '@shared/constants';
import { newNote, type DraftNote } from '../lib/draft';
import { isSeqOrdered, permuteWithinType, placeBySeq, sortBySeq } from '../lib/noteOrder';
import { initialNoteTab, rememberNoteTab } from '../lib/noteTabs';
import { MarkdownField } from './MarkdownField';
import { Tabs } from './Tabs';
import { useToast } from './ui';

const TONE: Record<NoteType, string> = { note: 'chip-stone', answer: '', solution: 'chip-clay' };

const EMPTY_HINT: Record<NoteType, string> = {
  note: '还没有笔记。可以写下自己的思考、易错点或讲解思路。',
  solution: '还没有解析。可以写参考解析或自己的解法，支持公式与 callout。',
  answer: '还没有答案。多问的题可以每问一条，并填上序号。',
};

/** 序号输入：失焦或回车时提交；空为清除，非法值还原。 */
function SeqInput({ note, index, onCommit }: { note: DraftNote; index: number; onCommit: (seq: number | null) => void }) {
  const [text, setText] = useState(note.seq === null ? '' : String(note.seq));
  useEffect(() => setText(note.seq === null ? '' : String(note.seq)), [note.seq]);
  const commit = () => {
    const t = text.trim();
    if (t === '') {
      if (note.seq !== null) onCommit(null);
      return;
    }
    const v = Number(t);
    if (!Number.isInteger(v) || v < 0 || v > NOTE_SEQ_MAX) {
      setText(note.seq === null ? '' : String(note.seq));
      return;
    }
    if (v !== note.seq) onCommit(v);
  };
  return (
    <label className="flex items-center gap-0.5 text-sm text-ink-soft" title="可选序号，例如对应第几问；填写后自动排到相应位置">
      <span aria-hidden="true">(</span>
      <input
        className="w-10 border-0 border-b border-transparent bg-transparent px-0.5 py-0.5 text-center tabular-nums focus:border-line-strong focus:outline-none"
        inputMode="numeric"
        value={text}
        placeholder="序号"
        aria-label={`第 ${index + 1} 条${NOTE_TYPE_LABELS[note.type]}的序号`}
        onChange={(e) => setText(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
        onBlur={commit}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <span aria-hidden="true">)</span>
    </label>
  );
}

function SortableNote({
  note,
  index,
  total,
  fresh,
  onUpdate,
  onSeq,
  onRemove,
  onImageFiles,
}: {
  note: DraftNote;
  index: number;
  total: number;
  fresh: boolean;
  onUpdate: (patch: Partial<DraftNote>) => void;
  onSeq: (seq: number | null) => void;
  onRemove: () => void;
  onImageFiles: (files: File[]) => Promise<string>;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: note.id });
  const label = NOTE_TYPE_LABELS[note.type];
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`card-flat px-4 pb-4 pt-3 ${isDragging ? 'relative z-10 shadow-[var(--shadow-lift)]' : ''}`}
      data-note-type={note.type}
      data-testid="note"
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          ref={setActivatorNodeRef}
          type="button"
          className="btn btn-ghost btn-icon cursor-grab touch-none active:cursor-grabbing"
          aria-label={`拖动排序：第 ${index + 1} 条${label}（共 ${total} 条）`}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={16} />
        </button>
        <SeqInput note={note} index={index} onCommit={onSeq} />
        <input
          className="min-w-[10rem] flex-1 border-0 border-b border-transparent bg-transparent px-1 py-0.5 font-serif font-semibold text-stone placeholder:font-normal placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
          value={note.title}
          maxLength={300}
          placeholder="标题（可选，例如：我的解法 / 参考解析）"
          aria-label="笔记标题"
          onChange={(e) => onUpdate({ title: e.target.value })}
        />
        <select
          className={`chip ${TONE[note.type]} cursor-pointer border-0 pr-2 font-semibold`}
          value={note.type}
          aria-label="笔记类型"
          title="改类型后，这条会移到对应的栏里"
          onChange={(e) => onUpdate({ type: e.target.value as NoteType })}
        >
          {NOTE_TYPES.map((t) => (
            <option key={t} value={t}>
              {NOTE_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-ghost btn-icon hover:!text-terracotta" aria-label={`删除第 ${index + 1} 条${label}`} onClick={onRemove}>
          <Trash2 size={16} />
        </button>
      </div>
      <MarkdownField
        value={note.bodyMd}
        onChange={(v) => onUpdate({ bodyMd: v })}
        ariaLabel={`${label}正文`}
        placeholder="用 Markdown 记录，例如 $x^2$、> [!tip] 提醒；可直接粘贴截图"
        startInEdit={fresh || !note.bodyMd}
        onImageFiles={onImageFiles}
      />
    </li>
  );
}

export function NotesEditor({
  notes,
  onChange,
  onImageFiles,
}: {
  notes: DraftNote[];
  onChange: (u: (n: DraftNote[]) => DraftNote[]) => void;
  onImageFiles: (files: File[]) => Promise<string>;
}) {
  const toast = useToast();
  const [fresh] = useState(() => new Set<string>());
  const [tab, setTabState] = useState<NoteType>(() => initialNoteTab(notes));
  // 页面先以空草稿挂载、随后载入笔记时，重新选一次默认栏
  const hadNotes = useRef(notes.length > 0);
  useEffect(() => {
    if (!hadNotes.current && notes.length > 0) {
      hadNotes.current = true;
      if (!notes.some((n) => n.type === tab)) setTabState(initialNoteTab(notes));
    }
  }, [notes, tab]);
  const setTab = (t: NoteType) => {
    setTabState(t);
    rememberNoteTab(t);
  };

  const visible = notes.filter((n) => n.type === tab);
  const label = NOTE_TYPE_LABELS[tab];
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const position = (id: UniqueIdentifier) => visible.findIndex((n) => n.id === id) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => `已拿起第 ${position(active.id)} 条${label}。`,
    onDragOver: ({ over }) => (over ? `移到第 ${position(over.id)} 条的位置。` : '不在可放置的位置。'),
    onDragEnd: ({ over }) => (over ? `已放到第 ${position(over.id)} 条的位置。` : '已放下，顺序不变。'),
    onDragCancel: () => '已取消拖动，顺序不变。',
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onChange((ns) => permuteWithinType(ns, tab, String(active.id), String(over.id)));
  };

  const update = (id: string, patch: Partial<DraftNote>) => {
    onChange((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    if (patch.type && patch.type !== tab) toast(`已移到“${NOTE_TYPE_LABELS[patch.type]}”栏`, 'info');
  };
  const setSeq = (id: string, seq: number | null) => onChange((ns) => placeBySeq(ns.map((n) => (n.id === id ? { ...n, seq } : n)), id));
  const add = () => {
    const n = newNote(tab);
    fresh.add(n.id);
    onChange((ns) => [...ns, n]);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          label="笔记类型"
          idPrefix="notes"
          value={tab}
          onChange={setTab}
          items={NOTE_TAB_ORDER.map((t) => ({ id: t, label: NOTE_TYPE_LABELS[t], count: notes.filter((n) => n.type === t).length }))}
        />
        <span className="flex-1" />
        {!isSeqOrdered(notes, tab) ? (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange((ns) => sortBySeq(ns, tab))}>
            <ArrowDownWideNarrow size={15} /> 按序号重排
          </button>
        ) : null}
      </div>
      <div id="notes-panel" role="tabpanel" aria-labelledby={`notes-tab-${tab}`} className="space-y-3">
        {visible.length === 0 ? <p className="text-sm text-ink-soft">{EMPTY_HINT[tab]}</p> : null}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          // 拖动开始前就量好各条的位置：键盘拿起后立即按方向键也能移动
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragEnd={onDragEnd}
          accessibility={{
            announcements,
            screenReaderInstructions: { draggable: '按空格或回车拿起，用上下方向键移动，再按空格或回车放下；按 Esc 取消。' },
          }}
        >
          <SortableContext items={visible.map((n) => n.id)} strategy={verticalListSortingStrategy}>
            <ol className="space-y-3" aria-label={`${label}列表`}>
              {visible.map((n, i) => (
                <SortableNote
                  key={n.id}
                  note={n}
                  index={i}
                  total={visible.length}
                  fresh={fresh.has(n.id)}
                  onUpdate={(patch) => update(n.id, patch)}
                  onSeq={(seq) => setSeq(n.id, seq)}
                  onRemove={() => {
                    onChange((ns) => ns.filter((x) => x.id !== n.id));
                    toast(`已移除该${label}。保存后生效，之后可在回收站恢复。`, 'info');
                  }}
                  onImageFiles={onImageFiles}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
        <div>
          <button type="button" className="btn btn-sm btn-sage" onClick={add}>
            <Plus size={15} /> 添加{label}
          </button>
        </div>
      </div>
    </div>
  );
}
