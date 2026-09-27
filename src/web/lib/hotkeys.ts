/** 键盘快捷键的公共判断：输入框、CodeMirror、输入法组字与打开的对话框内不触发列表快捷键。 */
import { useEffect, useRef } from 'react';

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return Boolean(t.closest('input, textarea, select, [contenteditable="true"], .cm-editor'));
}

/** 页面上是否有打开的模态层（原生 dialog 或 Radix 菜单/弹出层）。 */
export function hasOpenOverlay(): boolean {
  return Boolean(document.querySelector('dialog[open], [data-radix-popper-content-wrapper], [role="menu"]'));
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD_LABEL = isMac ? '⌘' : 'Ctrl';

/** 全局 keydown 监听；handler 返回 true 表示已处理（阻止默认行为）。 */
export function useKeydown(handler: (e: KeyboardEvent) => boolean | void, enabled = true): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (ref.current(e) === true) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
