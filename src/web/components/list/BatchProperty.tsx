/** 批量设置属性：先选属性，再选取值（单选替换、多选追加或移除、其他类型直接填写）。 */
import { ArrowLeft, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { BatchAction, BatchResultDTO, PropertyDefDTO } from '@shared/api';
import { PROPERTY_TYPE_LABELS } from '@shared/constants';
import type { Collection } from '../../lib/queries';
import { propertiesFor, useCatalog } from '../../lib/useCatalog';
import { Popover, PopoverContent, PopoverTrigger } from '../Menu';
import { OptionPicker } from '../props/OptionPicker';

type Run = (ids: string[], action: BatchAction, verb: string) => Promise<BatchResultDTO | null>;

function ScalarForm({ def, onApply }: { def: PropertyDefDTO; onApply: (v: { text?: string; number?: number; date?: string } | null) => void }) {
  const [v, setV] = useState('');
  const type = def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text';
  return (
    <form
      className="space-y-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!v.trim()) return;
        onApply(def.type === 'number' ? { number: Number(v) } : def.type === 'date' ? { date: v } : { text: v.trim() });
      }}
    >
      <input className="input" type={type} value={v} autoFocus aria-label={`${def.name}的新值`} onChange={(e) => setV(e.target.value)} />
      <div className="flex justify-end gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onApply(null)}>
          清除{def.name}
        </button>
        <button type="submit" className="btn btn-sage btn-sm" disabled={!v.trim()}>
          应用
        </button>
      </div>
    </form>
  );
}

export function BatchProperty({ collection, ids, run }: { collection: Collection; ids: string[]; run: Run }) {
  const catalog = useCatalog();
  const defs = propertiesFor(catalog, collection);
  const [open, setOpen] = useState(false);
  const [defId, setDefId] = useState<string | null>(null);
  const [mode, setMode] = useState<'add' | 'remove'>('add');
  const def = defs.find((d) => d.id === defId) ?? null;
  if (defs.length === 0) return null;

  const done = () => {
    setOpen(false);
    setDefId(null);
  };
  const set = (d: PropertyDefDTO, value: Record<string, unknown> | null, label: string) => {
    done();
    void run(ids, { op: 'setProperty', propertyId: d.id, value: value ? { propertyId: d.id, ...value } : null }, value ? `已设置${d.name}为“${label}”：` : `已清除${d.name}：`);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setDefId(null);
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className="btn btn-sm">
          <SlidersHorizontal size={14} /> 设属性
        </button>
      </PopoverTrigger>
      <PopoverContent>
        {!def ? (
          <div className="w-64 p-1.5" role="menu" aria-label="选择属性">
            {defs.map((d) => (
              <button key={d.id} type="button" role="menuitem" className="menu-item w-full text-left" onClick={() => setDefId(d.id)}>
                <span className="flex-1 font-semibold">{d.name}</span>
                <span className="text-xs text-ink-faint">{PROPERTY_TYPE_LABELS[d.type]}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="w-80">
            <div className="flex items-center gap-2 border-b border-line px-2 py-1.5 text-sm">
              <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="返回" onClick={() => setDefId(null)}>
                <ArrowLeft size={14} />
              </button>
              <span className="font-semibold text-stone">{def.name}</span>
              {def.type === 'multiselect' ? (
                <div className="segmented ml-auto" role="group" aria-label="追加或移除">
                  <button type="button" aria-pressed={mode === 'add'} onClick={() => setMode('add')}>
                    追加
                  </button>
                  <button type="button" aria-pressed={mode === 'remove'} onClick={() => setMode('remove')}>
                    移除
                  </button>
                </div>
              ) : null}
            </div>
            {def.type === 'select' ? (
              <>
                <OptionPicker def={def} selected={[]} onPick={(oid) => set(def, { optionIds: [oid] }, def.options.find((o) => o.id === oid)?.path ?? '')} />
                <div className="border-t border-line p-1.5">
                  <button type="button" className="menu-item w-full" onClick={() => set(def, null, '')}>
                    清除{def.name}
                  </button>
                </div>
              </>
            ) : def.type === 'multiselect' ? (
              <OptionPicker
                def={def}
                selected={[]}
                allowCreate={mode === 'add'}
                placeholder={mode === 'add' ? `追加${def.name}…` : `从所选内容中移除${def.name}…`}
                onPick={(oid) => {
                  const path = def.options.find((o) => o.id === oid)?.path ?? '';
                  done();
                  void run(
                    ids,
                    { op: mode === 'add' ? 'addOptions' : 'removeOptions', propertyId: def.id, optionIds: [oid] },
                    mode === 'add' ? `已追加${def.name}“${path}”：` : `已移除${def.name}“${path}”：`,
                  );
                }}
              />
            ) : def.type === 'checkbox' ? (
              <div className="flex gap-2 p-3">
                <button type="button" className="btn btn-sage btn-sm flex-1" onClick={() => set(def, { checked: true }, '是')}>
                  设为“是”
                </button>
                <button type="button" className="btn btn-sm flex-1" onClick={() => set(def, null, '')}>
                  设为“否”
                </button>
              </div>
            ) : (
              <ScalarForm def={def} onApply={(v) => set(def, v, v ? String(Object.values(v)[0]) : '')} />
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
