/** 导航里的“常用检索”：带计数，点击把查询写进搜索框；右键改名、上移/下移、删除。 */
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Bookmark, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { SavedSearchDTO, SavedSearchScope } from '@shared/api';
import { errorMessage, getJSON, sendJSON } from '../../lib/api';
import { invalidateWrites } from '../../lib/queryClient';
import { ContextContent, ContextItem, ContextMenu, ContextSeparator, ContextTrigger } from '../Menu';
import { useConfirm, useToast } from '../ui';

export function SavedSearchesNav({ scope, currentQ, onOpen, section }: { scope: SavedSearchScope; currentQ: string; onOpen: (s: SavedSearchDTO) => void; section: (children: React.ReactNode) => React.ReactNode }) {
  const toast = useToast();
  const confirm = useConfirm();
  const list = useQuery({ queryKey: ['catalog', 'savedSearches', scope], queryFn: () => getJSON<SavedSearchDTO[]>(`/api/saved-searches?scope=${scope}`) });
  const counts = useQuery({ queryKey: ['nav', 'savedSearchCounts', scope], queryFn: () => getJSON<Record<string, number>>(`/api/saved-searches/counts?scope=${scope}`) });
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const items = (list.data ?? []).filter((s) => s.showInNav);
  if (items.length === 0) return null;

  const call = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      invalidateWrites({ problems: [], materials: [] });
      if (ok) toast(ok, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const move = (id: string, delta: number) => {
    const ids = items.map((s) => s.id);
    const i = ids.indexOf(id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void call(() => sendJSON('POST', '/api/saved-searches/reorder', { scope, ids }));
  };

  return section(
    <ul className="space-y-0.5" aria-label="常用检索">
      {items.map((s, i) => (
        <li key={s.id}>
          {renaming?.id === s.id ? (
            <form
              className="px-2"
              onSubmit={(e) => {
                e.preventDefault();
                void call(() => sendJSON('PUT', `/api/saved-searches/${s.id}`, { name: renaming.name }), '已改名').then(() => setRenaming(null));
              }}
            >
              <input
                className="input py-0.5 text-sm"
                value={renaming.name}
                autoFocus
                maxLength={60}
                aria-label="常用检索新名称"
                onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                onBlur={() => setRenaming(null)}
                onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
              />
            </form>
          ) : (
            <ContextMenu>
              <ContextTrigger asChild>
                <button
                  type="button"
                  className="tree-row w-full pl-6 text-left"
                  data-active={currentQ === s.text || undefined}
                  title={s.problems.length ? `${s.text}\n注意：${s.problems.join('；')}` : s.text}
                  onClick={() => onOpen(s)}
                >
                  <Bookmark size={13} className="flex-none text-ink-faint" />
                  <span className={`min-w-0 truncate ${s.problems.length ? 'text-ochre' : ''}`}>{s.name}</span>
                  <span className="tree-count">{counts.data?.[s.id] ?? ''}</span>
                </button>
              </ContextTrigger>
              <ContextContent>
                <ContextItem onSelect={() => setRenaming({ id: s.id, name: s.name })}>
                  <Pencil size={13} /> 改名
                </ContextItem>
                <ContextItem disabled={i === 0} onSelect={() => move(s.id, -1)}>
                  <ArrowUp size={13} /> 上移
                </ContextItem>
                <ContextItem disabled={i === items.length - 1} onSelect={() => move(s.id, 1)}>
                  <ArrowDown size={13} /> 下移
                </ContextItem>
                <ContextSeparator />
                <ContextItem
                  danger
                  onSelect={async () => {
                    if (await confirm({ title: `删除常用检索“${s.name}”`, message: '只删除这条保存的检索，不影响任何题目或资料。', confirmLabel: '删除', danger: true })) {
                      void call(() => sendJSON('POST', `/api/saved-searches/${s.id}/delete`), '已删除');
                    }
                  }}
                >
                  <Trash2 size={13} /> 删除
                </ContextItem>
              </ContextContent>
            </ContextMenu>
          )}
        </li>
      ))}
    </ul>,
  );
}
