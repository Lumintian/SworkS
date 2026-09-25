import { useEffect, type ReactNode } from 'react';
import { Save } from 'lucide-react';
import type { SaveState } from '../lib/useEntityEditor';

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function useSaveShortcut(save: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save]);
}

/** 保存状态条：只有服务端确认后才显示“已保存”；失败时明确提示且保留页面内容。 */
export function SaveBar({
  title,
  state,
  dirty,
  canSave,
  onSave,
  actions,
}: {
  title: ReactNode;
  state: SaveState;
  dirty: boolean;
  canSave: boolean;
  onSave: () => void;
  actions?: ReactNode;
}) {
  let status: ReactNode = null;
  if (state.kind === 'saving') status = <span className="text-ink-soft">保存中…</span>;
  else if (state.kind === 'error')
    status = (
      <span className="font-semibold text-terracotta" role="alert">
        保存失败：{state.message}（内容仍在页面上）
      </span>
    );
  else if (dirty) status = <span className="font-semibold text-ochre">有未保存的修改</span>;
  else if (state.kind === 'saved')
    status = (
      <span className="font-semibold text-sage-deep" data-testid="saved-indicator">
        已保存 {pad(state.at.getHours())}:{pad(state.at.getMinutes())}:{pad(state.at.getSeconds())}
      </span>
    );
  return (
    <div className="sticky top-0 z-20 -mx-4 mb-4 border-b border-line bg-paper/95 px-4 py-2.5 backdrop-blur-[2px] md:-mx-8 md:px-8">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1 truncate text-sm text-ink-soft">{title}</div>
        <div className="text-sm" aria-live="polite" data-testid="save-status">
          {status}
        </div>
        {actions}
        <button type="button" className="btn btn-primary" disabled={!canSave || state.kind === 'saving'} onClick={onSave} title="保存（Ctrl+S）" data-testid="save-button">
          <Save size={16} /> {state.kind === 'error' ? '重试保存' : '保存'}
        </button>
      </div>
    </div>
  );
}
