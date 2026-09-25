/** 类型化笔记：普通笔记 / 答案 / 解析，可多条并排序；正文为 Markdown 源码。 */
import { useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { NOTE_TYPE_LABELS, NOTE_TYPES, type NoteType } from '@shared/constants';
import { newNote, type DraftNote } from '../lib/draft';
import { MarkdownField } from './MarkdownField';
import { useToast } from './ui';

const TONE: Record<NoteType, string> = { note: 'chip-stone', answer: '', solution: 'chip-clay' };

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
  const update = (id: string, patch: Partial<DraftNote>) => onChange((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)));
  const move = (i: number, d: -1 | 1) =>
    onChange((ns) => {
      const j = i + d;
      if (j < 0 || j >= ns.length) return ns;
      const next = [...ns];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const add = (type: NoteType) => {
    const n = newNote(type);
    fresh.add(n.id);
    onChange((ns) => [...ns, n]);
  };
  return (
    <div className="space-y-3">
      {notes.length === 0 ? <p className="text-sm text-ink-soft">还没有笔记。可以添加自己的思考、答案或解析，均支持公式与 callout。</p> : null}
      <ol className="space-y-3" aria-label="笔记列表">
        {notes.map((n, i) => (
          <li key={n.id} className="card-flat px-4 pb-4 pt-3" data-note-type={n.type} data-testid="note">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <select
                className={`chip ${TONE[n.type]} cursor-pointer border-0 pr-2 font-semibold`}
                value={n.type}
                aria-label="笔记类型"
                onChange={(e) => update(n.id, { type: e.target.value as NoteType })}
              >
                {NOTE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {NOTE_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
              <input
                className="min-w-[10rem] flex-1 border-0 border-b border-transparent bg-transparent px-1 py-0.5 font-serif font-semibold text-stone placeholder:font-normal placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
                value={n.title}
                maxLength={300}
                placeholder="标题（可选，例如：我的解法 / 参考解析）"
                aria-label="笔记标题"
                onChange={(e) => update(n.id, { title: e.target.value })}
              />
              <div className="flex items-center gap-1">
                <button type="button" className="btn btn-ghost btn-icon" aria-label={`上移第 ${i + 1} 条笔记`} disabled={i === 0} onClick={() => move(i, -1)}>
                  <ArrowUp size={16} />
                </button>
                <button type="button" className="btn btn-ghost btn-icon" aria-label={`下移第 ${i + 1} 条笔记`} disabled={i === notes.length - 1} onClick={() => move(i, 1)}>
                  <ArrowDown size={16} />
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-icon hover:!text-terracotta"
                  aria-label={`删除第 ${i + 1} 条笔记`}
                  onClick={() => {
                    onChange((ns) => ns.filter((x) => x.id !== n.id));
                    toast('已移除该笔记。保存后生效，之后可在回收站恢复。', 'info');
                  }}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            <MarkdownField
              value={n.bodyMd}
              onChange={(v) => update(n.id, { bodyMd: v })}
              ariaLabel={`${NOTE_TYPE_LABELS[n.type]}正文`}
              placeholder="用 Markdown 记录，例如 $x^2$、> [!tip] 提醒；可直接粘贴截图"
              startInEdit={fresh.has(n.id) || !n.bodyMd}
              onImageFiles={onImageFiles}
            />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        {NOTE_TYPES.map((t) => (
          <button key={t} type="button" className="btn btn-sm btn-sage" onClick={() => add(t)}>
            <Plus size={15} /> {NOTE_TYPE_LABELS[t]}
          </button>
        ))}
      </div>
    </div>
  );
}
