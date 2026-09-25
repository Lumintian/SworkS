/** Markdown 源码编辑 + 预览：宽屏可分栏，窄屏在“源码/预览”间切换；阅读模式只显示渲染结果。 */
import { useDeferredValue, useEffect, useState } from 'react';
import { Eye, PencilLine } from 'lucide-react';
import { MarkdownView } from '../markdown/MarkdownView';
import { CodeEditor } from './CodeEditor';

type EditView = 'source' | 'preview' | 'split';

function useWide(): boolean {
  const query = '(min-width: 1180px)';
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export function MarkdownField({
  value,
  onChange,
  ariaLabel,
  placeholder,
  startInEdit,
  onImageFiles,
  emptyLabel = '（空）',
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  placeholder?: string;
  startInEdit?: boolean;
  onImageFiles?: (files: File[]) => Promise<string>;
  emptyLabel?: string;
}) {
  const wide = useWide();
  const [editing, setEditing] = useState(Boolean(startInEdit));
  const [view, setView] = useState<EditView>(() => (wide ? 'split' : 'source'));
  const deferred = useDeferredValue(value);
  const effective: EditView = view === 'split' && !wide ? 'source' : view;

  if (!editing) {
    return (
      <div className="group relative">
        {value.trim() ? (
          <MarkdownView source={value} />
        ) : (
          <p className="text-sm italic text-ink-faint">{emptyLabel}</p>
        )}
        <div className="mt-2 flex justify-end">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(true)} aria-label={`编辑：${ariaLabel}`}>
            <PencilLine size={15} /> 编辑
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="segmented" role="group" aria-label="编辑视图">
          <button type="button" aria-pressed={effective === 'source'} onClick={() => setView('source')}>
            源码
          </button>
          <button type="button" aria-pressed={effective === 'preview'} onClick={() => setView('preview')}>
            预览
          </button>
          {wide ? (
            <button type="button" aria-pressed={effective === 'split'} onClick={() => setView('split')}>
              分栏
            </button>
          ) : null}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
          <Eye size={15} /> 完成
        </button>
      </div>
      <div className={effective === 'split' ? 'grid grid-cols-2 gap-4' : ''}>
        <div className={effective === 'preview' ? 'hidden' : 'min-w-0'}>
          <CodeEditor
            value={value}
            onChange={onChange}
            ariaLabel={ariaLabel}
            {...(placeholder ? { placeholder } : {})}
            autoFocus={Boolean(startInEdit) || editing}
            {...(onImageFiles ? { onImageFiles } : {})}
          />
        </div>
        {effective !== 'source' ? (
          <div className="min-w-0 rounded-[10px] border border-dashed border-line bg-surface px-4 py-3" aria-label="预览">
            {deferred.trim() ? <MarkdownView source={deferred} /> : <p className="text-sm italic text-ink-faint">预览区</p>}
          </div>
        ) : null}
      </div>
    </div>
  );
}
