import { useId, type ReactNode } from 'react';
import { MATERIAL_STATUS_LABELS, type MaterialStatus } from '@shared/constants';
import type { PropertyValueDTO } from '@shared/api';
import type { BaseDraft } from '../lib/draft';
import { Link } from '../lib/router';
import { propertiesFor, useCatalog } from '../lib/useCatalog';
import { PropertyField } from './props/PropertyField';
import { TagInput } from './TagInput';

/** 属性表中的一行：左侧名称，右侧控件（参照 Obsidian 的属性面板）。 */
function PropRow({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 items-start gap-1 border-b border-line/70 py-2 last:border-b-0 sm:grid-cols-[7rem_1fr] sm:gap-3">
      {htmlFor ? (
        <label className="label mb-0 pt-2" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="label mb-0 pt-2">{label}</span>
      )}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function DictInput({ id, value, options, onChange }: { id: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <>
      <input id={id} className="input max-w-[16rem]" list={`${id}-list`} value={value} placeholder="可留空" maxLength={50} onChange={(e) => onChange(e.target.value)} />
      <datalist id={`${id}-list`}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </>
  );
}

/** 属性区：标题（可选）、学科、学段、自定义属性（题型、难度、考点…）、标签、来源备注。全部非必填。 */
export function AttributeBar<D extends BaseDraft>({
  draft,
  setDraft,
  titlePlaceholder,
  kind,
  status,
  onStatus,
}: {
  draft: D;
  setDraft: (u: (d: D) => D) => void;
  titlePlaceholder: string;
  kind: 'problems' | 'materials';
  status?: MaterialStatus;
  onStatus?: (s: MaterialStatus) => void;
}) {
  const catalog = useCatalog();
  const subjectId = useId();
  const stageId = useId();
  const noteId = useId();
  const defs = propertiesFor(catalog, kind);
  const valueOf = (pid: string) => draft.properties.find((v) => v.propertyId === pid);
  const setValue = (pid: string, v: PropertyValueDTO | undefined) =>
    setDraft((d) => ({ ...d, properties: [...d.properties.filter((x) => x.propertyId !== pid), ...(v ? [v] : [])] }));

  return (
    <section aria-label="属性" className="space-y-2">
      <input
        className="w-full border-0 border-b border-transparent bg-transparent px-0 py-1 font-serif text-2xl font-semibold text-stone placeholder:font-normal placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
        value={draft.title}
        maxLength={300}
        placeholder={titlePlaceholder}
        aria-label="标题（可选）"
        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
      />
      <div className="card-flat px-4 py-1" data-testid="properties-panel">
        <PropRow label="学科" htmlFor={subjectId}>
          <DictInput id={subjectId} value={draft.subject} options={catalog.subjects} onChange={(v) => setDraft((d) => ({ ...d, subject: v }))} />
        </PropRow>
        <PropRow label="学段" htmlFor={stageId}>
          <DictInput id={stageId} value={draft.stage} options={catalog.stages} onChange={(v) => setDraft((d) => ({ ...d, stage: v }))} />
        </PropRow>
        {status && onStatus ? (
          <PropRow label="整理状态">
            <div className="segmented" role="group" aria-label="整理状态">
              {(['inbox', 'active'] as const).map((s) => (
                <button key={s} type="button" aria-pressed={status === s} onClick={() => onStatus(s)}>
                  {MATERIAL_STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </PropRow>
        ) : null}
        {defs.map((def) => (
          <PropRow key={def.id} label={def.name}>
            <PropertyField def={def} value={valueOf(def.id)} onChange={(v) => setValue(def.id, v)} />
          </PropRow>
        ))}
        <PropRow label="标签">
          <TagInput value={draft.tags} onChange={(tags) => setDraft((d) => ({ ...d, tags }))} suggestions={catalog.tags.map((t) => t.name)} />
        </PropRow>
        <PropRow label="来源备注" htmlFor={noteId}>
          <input
            id={noteId}
            className="input"
            value={draft.sourceNote}
            maxLength={4000}
            placeholder="例如：某地模拟卷第 12 题、网页地址"
            onChange={(e) => setDraft((d) => ({ ...d, sourceNote: e.target.value }))}
          />
        </PropRow>
        <p className="py-1.5 text-right text-xs text-ink-faint">
          <Link to="/manage?tab=properties" className="hover:text-stone">
            管理属性与选项 →
          </Link>
        </p>
      </div>
    </section>
  );
}
