/** 给教案加题：按关键词搜索题目（与列表页同一个检索接口），没有关键词时列出最近修改的题。选完不关闭，可以连续添加。 */
import { Command } from 'cmdk';
import { Check, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ListItemDTO, ListResponse } from '@shared/api';
import { errorMessage, getJSON } from '../../lib/api';

export function ProblemPicker({ exclude, onPick }: { exclude: ReadonlySet<string>; onPick: (item: ListItemDTO) => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ListItemDTO[] | null>(null);
  const [error, setError] = useState('');
  const kw = q.trim();

  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(
      () => {
        const p = new URLSearchParams({ limit: '20' });
        if (kw) p.set('q', kw);
        else p.set('sort', 'updated');
        getJSON<ListResponse>(`/api/problems?${p.toString()}`).then(
          (r) => {
            if (!alive) return;
            setItems(r.items);
            setError('');
          },
          (err: unknown) => alive && setError(errorMessage(err)),
        );
      },
      kw ? 180 : 0,
    );
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [kw]);

  return (
    <Command shouldFilter={false} label="搜索要加入教案的题目" loop className="w-[26rem] max-w-[calc(100vw-2rem)]">
      <Command.Input value={q} onValueChange={setQ} placeholder="搜索题目：关键词、#标签、考点:…" autoFocus data-testid="lesson-picker-input" />
      <Command.List>
        {error ? <div className="px-3 py-4 text-center text-xs text-terracotta">{error}</div> : null}
        {!kw && items?.length ? <div className="px-3 pb-1 pt-2 text-xs text-ink-faint">最近修改的题目</div> : null}
        {items?.map((it) => {
          const added = exclude.has(it.id);
          return (
            <Command.Item key={it.id} value={it.id} disabled={added} onSelect={() => onPick(it)} data-testid="lesson-picker-item">
              {added ? <Check size={14} className="flex-none text-sage-deep" /> : <Plus size={14} className="flex-none text-ink-faint" />}
              <span className="min-w-0 flex-1 truncate">
                <span className={it.title ? '' : 'italic text-ink-soft'}>{it.title ?? '未命名题目'}</span>
                {it.summary ? <span className="ml-2 text-xs text-ink-faint">{it.summary}</span> : null}
              </span>
              {added ? <span className="text-xs text-ink-faint">已在教案中</span> : null}
            </Command.Item>
          );
        })}
        {items && items.length === 0 ? <div className="px-3 py-4 text-center text-xs text-ink-faint">{kw ? '没有找到匹配的题目' : '还没有题目'}</div> : null}
      </Command.List>
    </Command>
  );
}
