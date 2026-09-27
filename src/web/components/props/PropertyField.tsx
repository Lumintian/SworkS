/** 编辑页里的单个属性控件：按类型渲染（选项少的单选用分段按钮，其余选项类用选择器）。 */
import { Plus, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { PropertyDefDTO, PropertyValueDTO } from '@shared/api';
import { Popover, PopoverContent, PopoverTrigger } from '../Menu';
import { OptionPicker } from './OptionPicker';

/** 选项数量不多、不分层的单选直接用分段按钮（例如难度、题型）。 */
function isSegmented(def: PropertyDefDTO): boolean {
  return def.type === 'select' && !def.nested && def.options.length > 0 && def.options.length <= 8;
}

export function PropertyField({
  def,
  value,
  onChange,
}: {
  def: PropertyDefDTO;
  value: PropertyValueDTO | undefined;
  /** 传 undefined 表示清空 */
  onChange: (v: PropertyValueDTO | undefined) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const selected = value?.optionIds ?? [];
  const segmented = isSegmented(def);

  if (segmented) {
    return (
      <div className="segmented flex-wrap" role="group" aria-label={def.name}>
        {def.options.map((o) => {
          const on = selected.includes(o.id);
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={on}
              title={on ? '再点一次取消' : undefined}
              onClick={() => onChange(on ? undefined : { propertyId: def.id, optionIds: [o.id] })}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (def.type === 'select' || def.type === 'multiselect') {
    const byId = new Map(def.options.map((o) => [o.id, o]));
    const toggle = (oid: string) => {
      if (def.type === 'select') {
        onChange(selected.includes(oid) ? undefined : { propertyId: def.id, optionIds: [oid] });
        setOpen(false);
        return;
      }
      const next = selected.includes(oid) ? selected.filter((x) => x !== oid) : [...selected, oid];
      onChange(next.length ? { propertyId: def.id, optionIds: next } : undefined);
    };
    return (
      <div className="flex min-h-[2.1rem] flex-wrap items-center gap-1.5" role="group" aria-label={def.name}>
        {selected.map((oid) => {
          const o = byId.get(oid);
          return (
            <span key={oid} className="chip chip-clay" title={o?.path}>
              {o ? (
                <>
                  {o.depth > 0 ? <span className="opacity-60">{o.path.slice(0, o.path.length - o.label.length)}</span> : null}
                  {o.label}
                </>
              ) : (
                '（已删除的选项）'
              )}
              <button type="button" aria-label={`移除${def.name} ${o?.path ?? ''}`} className="opacity-70 hover:opacity-100" onClick={() => toggle(oid)}>
                <X size={13} />
              </button>
            </span>
          );
        })}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="btn btn-ghost btn-sm" aria-label={`选择${def.name}`}>
              <Plus size={14} /> {selected.length ? '' : `选择${def.name}`}
            </button>
          </PopoverTrigger>
          <PopoverContent>
            <OptionPicker def={def} selected={selected} onPick={toggle} />
          </PopoverContent>
        </Popover>
      </div>
    );
  }

  if (def.type === 'checkbox') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          id={id}
          type="checkbox"
          className="h-4 w-4 accent-[var(--color-sage-deep)]"
          checked={Boolean(value?.checked)}
          aria-label={def.name}
          onChange={(e) => onChange(e.target.checked ? { propertyId: def.id, checked: true } : undefined)}
        />
        {value?.checked ? '是' : '否'}
      </label>
    );
  }

  if (def.type === 'number') {
    return (
      <input
        id={id}
        type="number"
        className="input max-w-[12rem]"
        aria-label={def.name}
        value={value?.number ?? ''}
        placeholder="可留空"
        onChange={(e) => onChange(e.target.value === '' ? undefined : { propertyId: def.id, number: Number(e.target.value) })}
      />
    );
  }

  if (def.type === 'date') {
    return (
      <input
        id={id}
        type="date"
        className="input max-w-[12rem]"
        aria-label={def.name}
        value={value?.date ?? ''}
        onChange={(e) => onChange(e.target.value ? { propertyId: def.id, date: e.target.value } : undefined)}
      />
    );
  }

  return (
    <input
      id={id}
      className="input"
      aria-label={def.name}
      maxLength={2000}
      value={value?.text ?? ''}
      placeholder="可留空"
      onChange={(e) => onChange(e.target.value ? { propertyId: def.id, text: e.target.value } : undefined)}
    />
  );
}
