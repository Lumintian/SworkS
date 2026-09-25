import { useId } from 'react';
import { MATERIAL_STATUS_LABELS, type MaterialStatus } from '@shared/constants';
import type { BaseDraft } from '../lib/draft';
import { useCatalog } from '../lib/useCatalog';
import { TagInput } from './TagInput';

function DictInput({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="min-w-[8.5rem] flex-1">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="input" list={`${id}-list`} value={value} placeholder="可留空" maxLength={50} onChange={(e) => onChange(e.target.value)} />
      <datalist id={`${id}-list`}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </div>
  );
}

/** 轻量属性区：标题（可选）、学科、学段、标签、来源备注。全部非必填。 */
export function AttributeBar<D extends BaseDraft>({
  draft,
  setDraft,
  titlePlaceholder,
  status,
  onStatus,
}: {
  draft: D;
  setDraft: (u: (d: D) => D) => void;
  titlePlaceholder: string;
  status?: MaterialStatus;
  onStatus?: (s: MaterialStatus) => void;
}) {
  const catalog = useCatalog();
  const noteId = useId();
  return (
    <section aria-label="属性" className="space-y-3">
      <input
        className="w-full border-0 border-b border-transparent bg-transparent px-0 py-1 font-serif text-2xl font-semibold text-stone placeholder:font-normal placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
        value={draft.title}
        maxLength={300}
        placeholder={titlePlaceholder}
        aria-label="标题（可选）"
        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
      />
      <div className="flex flex-wrap items-end gap-3">
        <DictInput label="学科" value={draft.subject} options={catalog.subjects} onChange={(v) => setDraft((d) => ({ ...d, subject: v }))} />
        <DictInput label="学段" value={draft.stage} options={catalog.stages} onChange={(v) => setDraft((d) => ({ ...d, stage: v }))} />
        {status && onStatus ? (
          <div>
            <span className="label">整理状态</span>
            <div className="segmented" role="group" aria-label="整理状态">
              {(['inbox', 'active'] as const).map((s) => (
                <button key={s} type="button" aria-pressed={status === s} onClick={() => onStatus(s)}>
                  {MATERIAL_STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <span className="label">标签</span>
          <TagInput value={draft.tags} onChange={(tags) => setDraft((d) => ({ ...d, tags }))} suggestions={catalog.tags.map((t) => t.name)} />
        </div>
        <div>
          <label className="label" htmlFor={noteId}>
            来源备注
          </label>
          <input
            id={noteId}
            className="input"
            value={draft.sourceNote}
            maxLength={4000}
            placeholder="例如：某地模拟卷第 12 题、网页地址"
            onChange={(e) => setDraft((d) => ({ ...d, sourceNote: e.target.value }))}
          />
        </div>
      </div>
    </section>
  );
}
