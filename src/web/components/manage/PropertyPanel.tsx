/**
 * 数据管理 → 某个属性的详情：名称、类型（可改，内置属性除外）、有多少题目在用、在题目/资料中使用、
 * 是否在左侧栏列出、归档；单选/多选属性下面是选项树。
 * 属性的几个操作（改名、左侧栏、归档…）也出现在左侧分类列表的右键菜单里，共用 usePropertyActions。
 */
import { Archive, ArchiveRestore, Check, Eye, MoreHorizontal, Pencil, Shapes, X } from 'lucide-react';
import { useState } from 'react';
import type { PropertyDefDTO, UsageDTO } from '@shared/api';
import { PROPERTY_TYPE_CHANGES, PROPERTY_TYPE_LABELS } from '@shared/constants';
import { propertyKey } from '@shared/query';
import { errorMessage, sendJSON } from '../../lib/api';
import { CATALOG_ONLY, invalidateWrites } from '../../lib/queryClient';
import { Link } from '../../lib/router';
import { DropdownContent, DropdownItem, DropdownMenu, DropdownTrigger } from '../Menu';
import { OptionTreeEditor } from '../props/OptionTreeEditor';
import { isNavType, isOptionType, NAV_HINT, PRESET_TYPE_HINT } from '../props/propertyText';
import { useConfirm, useToast } from '../ui';
import { NO_USAGE, usage as usageText, used } from './usage';

/** 悬停在“在题目/资料中使用”上的说明 */
const appliesHint = (kind: 'problem' | 'material') => {
  const noun = kind === 'problem' ? '题目' : '资料';
  return `${noun}的属性面板里有它，也能按它筛选${noun}。取消后已有的取值保留，只是不再显示`;
};

/** 不能改类型的原因；能改时为 null */
export function retypeBlock(d: PropertyDefDTO): string | null {
  if (d.preset) return PRESET_TYPE_HINT;
  if (d.archived) return '取消归档后才能改类型';
  return PROPERTY_TYPE_CHANGES[d.type].length ? null : `“${PROPERTY_TYPE_LABELS[d.type]}”属性不能改成别的类型`;
}

export function usePropertyActions() {
  const toast = useToast();
  const confirm = useConfirm();
  /** catalogOnly：只改了属性本身（名称、左侧栏），题目内容与题目页显示的取值都不变 */
  const update = async (d: PropertyDefDTO, body: Record<string, unknown>, ok?: string, catalogOnly = false) => {
    try {
      await sendJSON('PUT', `/api/properties/${d.id}`, body);
      invalidateWrites(catalogOnly ? CATALOG_ONLY : {});
      if (ok) toast(ok, 'success');
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  };
  return {
    rename: (d: PropertyDefDTO, name: string) => update(d, { name }, '已改名', true),
    toggleNav: (d: PropertyDefDTO) => void update(d, { showInNav: !d.showInNav }, d.showInNav ? `左侧栏不再列出“${d.name}”` : `已在左侧栏列出“${d.name}”`, true),
    /** 在题目/资料中使用：关掉时如果已有取值，先说明取值会保留但不再显示 */
    setApplies: async (d: PropertyDefDTO, kind: 'problem' | 'material', on: boolean, u: UsageDTO | undefined) => {
      const noun = kind === 'problem' ? '题目' : '资料';
      const n = on ? 0 : (u?.[kind === 'problem' ? 'problems' : 'materials'] ?? 0);
      if (n > 0) {
        const ok = await confirm({
          title: `“${d.name}”不再在${noun}中使用`,
          message: `已有 ${n} ${kind === 'problem' ? '道题' : '份资料'}设置了“${d.name}”。这些取值会保留，但${noun}里不再显示，也不能按它筛选和检索；重新勾选即可恢复。`,
          confirmLabel: `不再在${noun}中使用`,
        });
        if (!ok) return;
      }
      await update(d, kind === 'problem' ? { appliesProblem: on } : { appliesMaterial: on });
    },
    archive: async (d: PropertyDefDTO) => {
      const ok = await confirm({
        title: `归档属性“${d.name}”`,
        message: '归档后它不再出现在题目页、左侧栏和检索中；已有的取值原样保留，取消归档即可恢复。',
        confirmLabel: '归档',
      });
      if (!ok) return;
      try {
        await sendJSON('POST', `/api/properties/${d.id}/archive`);
        invalidateWrites();
        toast(`已归档“${d.name}”`, 'success', {
          label: '撤销',
          onClick: () =>
            void sendJSON('POST', `/api/properties/${d.id}/unarchive`).then(
              () => invalidateWrites(),
              (err: unknown) => toast(errorMessage(err), 'error'),
            ),
        });
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
    unarchive: async (d: PropertyDefDTO) => {
      try {
        await sendJSON('POST', `/api/properties/${d.id}/unarchive`);
        invalidateWrites();
        toast(`已取消归档“${d.name}”`, 'success');
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
  };
}

function RenameForm({ def, onDone }: { def: PropertyDefDTO; onDone: () => void }) {
  const actions = usePropertyActions();
  const [name, setName] = useState(def.name);
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || name.trim() === def.name) return onDone();
        void actions.rename(def, name.trim()).then((ok) => ok && onDone());
      }}
    >
      <input
        className="input max-w-sm py-1"
        value={name}
        autoFocus
        maxLength={40}
        aria-label="属性新名称"
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => e.key === 'Escape' && onDone()}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit" className="btn btn-sage btn-sm btn-icon" aria-label="确定">
        <Check size={14} />
      </button>
      <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="取消" onClick={onDone}>
        <X size={14} />
      </button>
    </form>
  );
}

export function PropertyPanel({
  def,
  usage,
  renaming,
  onRenamingChange,
  onRetype,
}: {
  def: PropertyDefDTO;
  usage: UsageDTO | undefined;
  renaming: boolean;
  onRenamingChange: (on: boolean) => void;
  onRetype: () => void;
}) {
  const actions = usePropertyActions();
  const u = usage ?? NO_USAGE;
  const live = { problems: u.problems, materials: u.materials, trashed: 0 };
  const block = retypeBlock(def);
  const hasOptions = isOptionType(def.type);
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          {renaming ? (
            <RenameForm def={def} onDone={() => onRenamingChange(false)} />
          ) : (
            <h2 className="min-w-0 truncate text-xl font-semibold text-stone">{def.name}</h2>
          )}
          <span className="chip">{PROPERTY_TYPE_LABELS[def.type]}</span>
          <span className="flex-1" />
          {renaming ? null : (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRenamingChange(true)}>
              <Pencil size={14} /> 改名
            </button>
          )}
          <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(block)} title={block ?? undefined} onClick={onRetype}>
            <Shapes size={14} /> 改类型
          </button>
          <DropdownMenu>
            <DropdownTrigger asChild>
              <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`“${def.name}”的更多操作`}>
                <MoreHorizontal size={16} />
              </button>
            </DropdownTrigger>
            <DropdownContent align="end">
              {def.archived ? (
                <DropdownItem onSelect={() => void actions.unarchive(def)}>
                  <ArchiveRestore size={13} /> 取消归档
                </DropdownItem>
              ) : (
                <DropdownItem danger disabled={Boolean(def.preset)} onSelect={() => void actions.archive(def)}>
                  <Archive size={13} /> {def.preset ? '归档（内置属性不能归档）' : '归档'}
                </DropdownItem>
              )}
            </DropdownContent>
          </DropdownMenu>
        </div>
        <p className="text-sm text-ink-soft">
          {used(live) ? `${usageText(live)}设置了它` : '还没有题目或资料设置它'}
          {u.trashed ? `（另有回收站中 ${u.trashed} 项）` : ''}。
          {used(live) ? (
            <Link to={`/problems?${new URLSearchParams({ q: `${propertyKey(def)}:*` }).toString()}`} className="link-btn ml-2 text-sm">
              <Eye size={13} className="mr-1 inline" />
              在题目列表中查看
            </Link>
          ) : null}
        </p>
      </header>

      {def.archived ? (
        <div className="flex flex-wrap items-center gap-3 border border-line bg-sunken px-3 py-2 text-sm text-ink-soft" style={{ borderRadius: 'var(--radius-organic-sm)' }}>
          <span className="flex-1">已归档：不出现在题目页、左侧栏和检索中，已有的取值原样保留。</span>
          <button type="button" className="btn btn-sm" onClick={() => void actions.unarchive(def)}>
            <ArchiveRestore size={14} /> 取消归档
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm" role="group" aria-label={`“${def.name}”的设置`}>
          {(['problem', 'material'] as const).map((kind) => {
            const on = kind === 'problem' ? def.appliesProblem : def.appliesMaterial;
            const other = kind === 'problem' ? def.appliesMaterial : def.appliesProblem;
            const hint = on && !other ? '至少要在题目或资料之一中使用' : appliesHint(kind);
            return (
              <label key={kind} className="flex items-center gap-1.5" title={hint}>
                <input
                  type="checkbox"
                  className="accent-[var(--color-sage-deep)]"
                  checked={on}
                  disabled={on && !other}
                  aria-description={hint}
                  onChange={(e) => void actions.setApplies(def, kind, e.target.checked, usage)}
                />
                在{kind === 'problem' ? '题目' : '资料'}中使用
              </label>
            );
          })}
          {isNavType(def.type) ? (
            <label className="flex items-center gap-1.5" title={NAV_HINT}>
              <input type="checkbox" className="accent-[var(--color-sage-deep)]" checked={def.showInNav} aria-description={NAV_HINT} onChange={() => actions.toggleNav(def)} />
              在左侧栏列出
            </label>
          ) : null}
        </div>
      )}

      {hasOptions && !def.archived ? (
        <section aria-label={`${def.name}的选项`}>
          <OptionTreeEditor def={def} />
        </section>
      ) : null}
    </div>
  );
}
