/**
 * 选项选择器（cmdk）：按路径搜索属性选项，层级属性（例如考点树）按缩进显示；
 * 可以直接输入新名称（支持用 / 写出多级路径）创建选项。
 */
import { Command } from 'cmdk';
import { Check, Plus } from 'lucide-react';
import { useState } from 'react';
import type { PropertyDefDTO } from '@shared/api';
import { errorMessage, sendJSON } from '../../lib/api';
import { invalidateWrites } from '../../lib/queryClient';
import { useToast } from '../ui';

export function OptionPicker({
  def,
  selected,
  onPick,
  allowCreate = true,
  placeholder,
}: {
  def: PropertyDefDTO;
  selected: readonly string[];
  /** 选中（或取消选中）某个选项 */
  onPick: (optionId: string) => void;
  allowCreate?: boolean;
  placeholder?: string;
}) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const k = q.trim().toLowerCase();
  const shown = def.options.filter((o) => !k || o.path.toLowerCase().includes(k)).slice(0, 200);
  const typed = q.trim();
  // 只按完整路径判断是否已存在：同名的末级选项可以出现在不同上级下（例如“通用/选择”与“英语/选择”）
  const typedPath = typed
    .split('/')
    .map((x) => x.trim())
    .filter(Boolean)
    .join('/')
    .toLowerCase();
  const exists = def.options.some((o) => o.path.toLowerCase() === typedPath);
  const canCreate = allowCreate && typed && !exists && (def.nested || !typed.includes('/'));

  const create = async () => {
    try {
      const r = await sendJSON<{ optionId: string }>('POST', `/api/properties/${def.id}/options/ensure-path`, { path: typed });
      invalidateWrites();
      setQ('');
      onPick(r.optionId);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <Command shouldFilter={false} label={`选择${def.name}`} loop className="w-80">
      <Command.Input value={q} onValueChange={setQ} placeholder={placeholder ?? (def.nested ? `搜索${def.name}，或输入“上级/名称”新建…` : `搜索或新建${def.name}…`)} autoFocus />
      <Command.List>
        {canCreate ? (
          <Command.Item value={`new:${typed}`} onSelect={() => void create()}>
            <Plus size={14} /> 新建“{typed}”
          </Command.Item>
        ) : null}
        {shown.map((o) => {
          const on = selected.includes(o.id);
          return (
            <Command.Item key={o.id} value={o.id} onSelect={() => onPick(o.id)}>
              <span className="w-4 flex-none text-sage-deep">{on ? <Check size={14} /> : null}</span>
              {k ? (
                <span className="truncate">{o.path}</span>
              ) : (
                <span className="truncate" style={{ paddingLeft: `${o.depth * 0.9}rem` }}>
                  {o.label}
                </span>
              )}
            </Command.Item>
          );
        })}
        {shown.length === 0 && !canCreate ? <div className="px-3 py-4 text-center text-xs text-ink-faint">{def.options.length ? '没有匹配的选项' : '还没有选项，输入名称即可新建'}</div> : null}
      </Command.List>
    </Command>
  );
}
