/** 列表多选：单项切换、Shift 连选（以上次点击为锚点）、全选；resetKey 变化（例如筛选条件改变）时清空。 */
import { useCallback, useEffect, useRef, useState } from 'react';

export function useSelection(orderedIds: readonly string[], resetKey: string) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);
  const order = useRef(orderedIds);
  order.current = orderedIds;

  useEffect(() => {
    setSelected(new Set());
    anchor.current = null;
  }, [resetKey]);

  const toggle = useCallback((id: string) => {
    anchor.current = id;
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  /** 从锚点到 id 的连续区间全部选中（锚点为空时等同于切换）。 */
  const selectRange = useCallback((id: string) => {
    const ids = order.current;
    const from = anchor.current ? ids.indexOf(anchor.current) : -1;
    const to = ids.indexOf(id);
    if (from === -1 || to === -1) {
      anchor.current = id;
      setSelected((s) => new Set(s).add(id));
      return;
    }
    const [a, b] = from < to ? [from, to] : [to, from];
    setSelected((s) => {
      const n = new Set(s);
      for (const x of ids.slice(a, b + 1)) n.add(x);
      return n;
    });
  }, []);

  const setAll = useCallback((ids: readonly string[]) => {
    setSelected(new Set(ids));
  }, []);

  const clear = useCallback(() => {
    anchor.current = null;
    setSelected(new Set());
  }, []);

  return { selected, toggle, selectRange, setAll, clear, has: (id: string) => selected.has(id) };
}

export type Selection = ReturnType<typeof useSelection>;
