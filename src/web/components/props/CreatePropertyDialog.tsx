/** 新建属性：名称、类型（每种带一个例子）、用在题目还是资料。选项是否分层不在这里问（第一次建下级时再确认）。 */
import { useState } from 'react';
import type { PropertyDefDTO } from '@shared/api';
import { PROPERTY_TYPE_LABELS, type PropertyType } from '@shared/constants';
import { errorMessage, sendJSON } from '../../lib/api';
import { newId } from '../../lib/format';
import { CATALOG_ONLY, invalidateWrites } from '../../lib/queryClient';
import { Dialog, useToast } from '../ui';
import { PROPERTY_TYPE_HINTS } from './propertyText';

/** 常用的放前面 */
const TYPE_ORDER: PropertyType[] = ['select', 'multiselect', 'text', 'number', 'date', 'checkbox'];

export function CreatePropertyDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (d: PropertyDefDTO) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState<PropertyType>('select');
  const [problem, setProblem] = useState(true);
  const [material, setMaterial] = useState(false);
  const [busy, setBusy] = useState(false);
  const valid = name.trim() !== '' && (problem || material);
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const d = await sendJSON<PropertyDefDTO>('POST', '/api/properties', { id: newId(), name: name.trim(), type, appliesProblem: problem, appliesMaterial: material });
      invalidateWrites(CATALOG_ONLY);
      toast(`已新建属性“${d.name}”`, 'success');
      setName('');
      onCreated(d);
      onClose();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="新建属性"
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="create-property" className="btn btn-primary" disabled={!valid || busy}>
            新建
          </button>
        </>
      }
    >
      <form
        id="create-property"
        className="space-y-4 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="block">
          <span className="label">名称</span>
          <input className="input" value={name} maxLength={40} autoFocus placeholder="例如：年份、地区、教材章节" onChange={(e) => setName(e.target.value)} />
        </label>
        <fieldset className="space-y-1">
          <legend className="label">类型</legend>
          {TYPE_ORDER.map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-sunken">
              <input type="radio" name="new-property-type" className="accent-[var(--color-sage-deep)]" checked={type === t} onChange={() => setType(t)} />
              <span className="w-10 font-semibold text-stone">{PROPERTY_TYPE_LABELS[t]}</span>
              <span className="text-ink-soft">{PROPERTY_TYPE_HINTS[t]}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-wrap items-center gap-4">
          <legend className="label">用在</legend>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" className="accent-[var(--color-sage-deep)]" checked={problem} onChange={(e) => setProblem(e.target.checked)} />
            题目
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" className="accent-[var(--color-sage-deep)]" checked={material} onChange={(e) => setMaterial(e.target.checked)} />
            资料
          </label>
          {!problem && !material ? <span className="text-xs text-terracotta">至少选一个</span> : null}
        </fieldset>
      </form>
    </Dialog>
  );
}
