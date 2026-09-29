/** 分段式标签页（沿用 .segmented 样式）：role=tablist，← → / Home / End 在标签之间切换。 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';

export interface TabItem<K extends string> {
  id: K;
  label: ReactNode;
  /** 显示在标签后的数量 */
  count?: number | undefined;
}

export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
  className = '',
  idPrefix,
}: {
  items: readonly TabItem<K>[];
  value: K;
  onChange: (id: K) => void;
  /** 标签组的无障碍名称 */
  label: string;
  className?: string;
  /** 设置后，标签与面板用 `${idPrefix}-tab-<id>` / `${idPrefix}-panel` 关联 */
  idPrefix?: string;
}) {
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const onKeyDown = (e: KeyboardEvent) => {
    const i = items.findIndex((t) => t.id === value);
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = items.length - 1;
    if (j < 0) return;
    // 不让全局快捷键（例如快速预览里的左右切换）同时响应
    e.preventDefault();
    e.stopPropagation();
    const next = items[j]!.id;
    onChange(next);
    refs.current.get(next)?.focus();
  };
  return (
    <div className={`segmented ${className}`} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {items.map((t) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${t.id}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel` : undefined}
            aria-selected={on}
            aria-pressed={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.count !== undefined ? <span className="ml-1 text-xs font-normal tabular-nums opacity-70">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
