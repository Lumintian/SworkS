/**
 * 修改自定义属性的类型：列出能改成的类型与取值怎样转换，选中后先在服务端试运行（执行后回滚），
 * 显示会改动多少题目、新建或删除多少选项、多少常用检索要重新设置；转换不了时显示原因。确认后可在提示里撤销。
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { PropertyDefDTO, PropertyTypeChangeDTO } from '@shared/api';
import { PROPERTY_TYPE_CHANGES, PROPERTY_TYPE_LABELS, type PropertyType } from '@shared/constants';
import { errorMessage, sendJSON } from '../../lib/api';
import { invalidateWrites } from '../../lib/queryClient';
import { UNDO_HINT } from '../manage/usage';
import { useUndoToast } from '../manage/useUndoToast';
import { Dialog, useToast } from '../ui';

const OPTION_TYPES: readonly PropertyType[] = ['select', 'multiselect'];

/** 取值怎样转换 */
export function conversionNote(from: PropertyType, to: PropertyType): string {
  if (from === 'select' && to === 'multiselect') return '原来的取值不变，之后每题可以选好几个。';
  if (from === 'multiselect' && to === 'select') return '每题只能选一个；有题目选了不止一个时不能改。';
  if (to === 'text') return OPTION_TYPES.includes(from) ? '选项写成文字（多选用“、”连接，分层的写成“上级/下级”），选项本身删除。' : '取值原样写成文字。';
  if (OPTION_TYPES.includes(to)) return '现有的不同文字各变成一个选项（只差大小写的算同一个）。';
  if (to === 'number') return '全部取值都能读成数字时才可以（全角数字也行）。';
  return '全部取值都能读成日期时才可以（2024-09-01、2024/9/1、2024年9月1日 都行）。';
}

function previewText(def: PropertyDefDTO, r: PropertyTypeChangeDTO): string {
  const parts = [r.affectedItems ? `会改写 ${r.affectedItems} 道题或资料的取值（含回收站中的）` : '不用改动任何题目的取值'];
  if (r.createdOptions) parts.push(`新建 ${r.createdOptions} 个选项`);
  if (r.removedOptions) parts.push(`删除 ${r.removedOptions} 个选项`);
  if (r.brokenSearches) parts.push(`${r.brokenSearches} 条常用检索里按“${def.name}”的条件需要重新设置`);
  return `${parts.join('，')}。`;
}

export function TypeChangeDialog({ def, open, onClose }: { def: PropertyDefDTO; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const undoToast = useUndoToast();
  const targets = PROPERTY_TYPE_CHANGES[def.type];
  const [to, setTo] = useState<PropertyType | null>(null);
  const [busy, setBusy] = useState(false);
  const preview = useQuery({
    queryKey: ['type-preview', def.id, def.type, to],
    queryFn: () => sendJSON<PropertyTypeChangeDTO>('POST', `/api/properties/${def.id}/type`, { type: to, dryRun: true }),
    enabled: open && to !== null,
    retry: false,
    staleTime: 0,
  });
  const close = () => {
    setTo(null);
    onClose();
  };
  const submit = async () => {
    if (!to) return;
    setBusy(true);
    try {
      const r = await sendJSON<PropertyTypeChangeDTO>('POST', `/api/properties/${def.id}/type`, { type: to });
      invalidateWrites();
      undoToast(`“${def.name}”已改为${PROPERTY_TYPE_LABELS[to]}${r.affectedItems ? `，改写了 ${r.affectedItems} 项的取值` : ''}`, r.undoId);
      close();
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const ready = to !== null && preview.isSuccess;
  return (
    <Dialog
      open={open}
      onClose={close}
      title={`修改“${def.name}”的类型`}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={close}>
            取消
          </button>
          <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={() => void submit()}>
            {to ? `改为${PROPERTY_TYPE_LABELS[to]}` : '修改类型'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-ink-soft">现在是“{PROPERTY_TYPE_LABELS[def.type]}”。改成：</p>
        {targets.length ? (
          <fieldset className="space-y-1.5">
            <legend className="sr-only">新类型</legend>
            {targets.map((t) => (
              <label key={t} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-sunken">
                <input type="radio" name="property-type" className="mt-1 accent-[var(--color-sage-deep)]" checked={to === t} onChange={() => setTo(t)} />
                <span>
                  <span className="font-semibold text-stone">{PROPERTY_TYPE_LABELS[t]}</span>
                  <span className="ml-2 text-ink-soft">{conversionNote(def.type, t)}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : (
          <p className="text-ink-faint">“{PROPERTY_TYPE_LABELS[def.type]}”属性不能改成别的类型。</p>
        )}
        {to ? (
          <p role="status" className={`border-t border-line pt-3 ${preview.isError ? 'text-terracotta' : 'text-ink-soft'}`}>
            {preview.isError ? errorMessage(preview.error) : preview.data ? `${previewText(def, preview.data)}${UNDO_HINT}` : '正在检查…'}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
