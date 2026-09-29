/** 只读的笔记分栏（笔记 / 解析 / 答案），用于快速预览。 */
import { useState } from 'react';
import type { NoteDTO } from '@shared/api';
import { NOTE_TAB_ORDER, NOTE_TYPE_LABELS, type NoteType } from '@shared/constants';
import { initialNoteTab, rememberNoteTab } from '../lib/noteTabs';
import { MarkdownView } from '../markdown/MarkdownView';
import { Tabs } from './Tabs';

/** 笔记标题：类型或标题前加序号，例如“(1) 求导”。 */
export function noteHeading(n: Pick<NoteDTO, 'type' | 'title' | 'seq'>): string {
  const seq = n.seq !== null ? `(${n.seq}) ` : '';
  return `${seq}${n.title ?? NOTE_TYPE_LABELS[n.type]}`;
}

/** 调用方用 key 区分不同对象，切换对象时重新选择默认栏。 */
export function NotesTabs({ notes, preferred }: { notes: readonly NoteDTO[]; preferred?: NoteType | null | undefined }) {
  const [tab, setTab] = useState<NoteType>(() => initialNoteTab(notes, preferred));
  const visible = notes.filter((n) => n.type === tab);
  return (
    <div className="space-y-3">
      <Tabs
        label="笔记类型"
        idPrefix="quicklook-notes"
        value={tab}
        onChange={(t) => {
          setTab(t);
          rememberNoteTab(t);
        }}
        items={NOTE_TAB_ORDER.map((t) => ({ id: t, label: NOTE_TYPE_LABELS[t], count: notes.filter((n) => n.type === t).length }))}
      />
      <div id="quicklook-notes-panel" role="tabpanel" aria-labelledby={`quicklook-notes-tab-${tab}`} className="space-y-3">
        {visible.length === 0 ? <p className="text-sm text-ink-faint">没有{NOTE_TYPE_LABELS[tab]}。</p> : null}
        {visible.map((n) => (
          <section key={n.id} className="card-flat px-4 py-3">
            <h3 className="mb-1 text-sm font-semibold text-stone">{noteHeading(n)}</h3>
            <MarkdownView source={n.bodyMd} />
          </section>
        ))}
      </div>
    </div>
  );
}
