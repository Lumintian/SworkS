/** 可搜索的标签选择器（cmdk）：选已有标签，或直接新建（支持用 / 分层）。 */
import { Command } from 'cmdk';
import { Hash, Plus } from 'lucide-react';
import { useState } from 'react';
import { normalizeTagInput, tagKey } from '@shared/tagPath';

export function TagPicker({ tags, onPick, placeholder = '搜索或新建标签…' }: { tags: string[]; onPick: (name: string) => void; placeholder?: string }) {
  const [q, setQ] = useState('');
  const typed = normalizeTagInput(q).slice(0, 60);
  const k = q.trim().toLowerCase();
  const shown = tags.filter((t) => !k || t.toLowerCase().includes(k)).slice(0, 50);
  const exists = typed && tags.some((t) => tagKey(t) === tagKey(typed));
  return (
    <Command shouldFilter={false} label="搜索或新建标签" loop className="w-72">
      <Command.Input value={q} onValueChange={setQ} placeholder={placeholder} autoFocus />
      <Command.List>
        {typed && !exists ? (
          <Command.Item value={`new:${typed}`} onSelect={() => onPick(typed)}>
            <Plus size={14} /> 新建并添加“{typed}”
          </Command.Item>
        ) : null}
        {shown.map((t) => (
          <Command.Item key={t} value={`tag:${t}`} onSelect={() => onPick(t)}>
            <Hash size={14} className="flex-none text-ink-faint" />
            <span className="truncate">{t}</span>
          </Command.Item>
        ))}
        {!typed && shown.length === 0 ? <div className="px-3 py-4 text-center text-xs text-ink-faint">还没有标签，输入名称即可新建</div> : null}
      </Command.List>
    </Command>
  );
}
