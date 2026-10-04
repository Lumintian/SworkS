/**
 * 数据管理 → 属性：新建自定义属性（名称、类型、用在题目/资料），
 * 调整顺序、改名、是否在左侧栏列出、归档（也可右键打开菜单）；选中单选/多选属性后编辑它的选项树。
 * 选项是否分层不在这里勾选：在选项树里第一次建下级时确认（见 OptionTreeEditor）。
 */
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Archive, ArchiveRestore, Check, Eye, EyeOff, ListTree, Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { PropertyDefDTO, UsageDTO } from '@shared/api';
import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES, type PropertyType } from '@shared/constants';
import { ContextContent, ContextItem, ContextMenu, ContextSeparator, ContextTrigger } from '../components/Menu';
import { OptionTreeEditor } from '../components/props/OptionTreeEditor';
import { useConfirm, useToast } from '../components/ui';
import { errorMessage, getJSON, sendJSON } from '../lib/api';
import { newId } from '../lib/format';
import { CATALOG_ONLY, invalidateWrites } from '../lib/queryClient';

/** 新建属性时每种类型的说明 */
export const PROPERTY_TYPE_HINTS: Record<PropertyType, string> = {
  select: '每题选一个，例如难度、题型',
  multiselect: '可以选好几个，例如考点',
  text: '一段文字，例如出处、教材版本',
  number: '一个数，例如年份、分值',
  date: '一个日期，例如考试日期',
  checkbox: '是或否，例如“重点”',
};

/** 内置属性（题型、难度、考点）不能归档的原因 */
export const PRESET_ARCHIVE_HINT = '内置属性不能归档；不想在左侧栏看到它，可以取消“在左侧栏列出”';
export const NAV_HINT = '在左侧栏列出它的选项和数量，点一下即可按它筛选；也可以把题目拖到选项上设置';

function CreateForm({ onCreated }: { onCreated: (d: PropertyDefDTO) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState<PropertyType>('select');
  const [problem, setProblem] = useState(true);
  const [material, setMaterial] = useState(false);
  return (
    <form
      className="card-flat flex flex-wrap items-end gap-3 px-4 py-3 text-sm"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const d = await sendJSON<PropertyDefDTO>('POST', '/api/properties', {
            id: newId(),
            name: name.trim(),
            type,
            appliesProblem: problem,
            appliesMaterial: material,
          });
          invalidateWrites(CATALOG_ONLY);
          toast(`已新建属性“${d.name}”`, 'success');
          setName('');
          onCreated(d);
        } catch (err) {
          toast(errorMessage(err), 'error');
        }
      }}
    >
      <label className="min-w-[10rem] flex-1">
        <span className="label">新属性名称</span>
        <input className="input" value={name} maxLength={40} placeholder="例如：年份、地区、教材章节" onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        <span className="label">类型</span>
        <select className="select w-auto" value={type} aria-describedby="new-property-type-hint" onChange={(e) => setType(e.target.value as PropertyType)}>
          {PROPERTY_TYPES.map((t) => (
            <option key={t} value={t}>
              {PROPERTY_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="flex items-center gap-3 pb-2">
        <legend className="sr-only">用在</legend>
        <span className="text-ink-soft">用在</span>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="accent-[var(--color-sage-deep)]" checked={problem} onChange={(e) => setProblem(e.target.checked)} />
          题目
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" className="accent-[var(--color-sage-deep)]" checked={material} onChange={(e) => setMaterial(e.target.checked)} />
          资料
        </label>
      </fieldset>
      <button type="submit" className="btn btn-sage" disabled={!name.trim() || (!problem && !material)}>
        <Plus size={15} /> 新建属性
      </button>
      <p id="new-property-type-hint" className="basis-full text-xs text-ink-faint">
        {PROPERTY_TYPE_LABELS[type]}：{PROPERTY_TYPE_HINTS[type]}
      </p>
    </form>
  );
}

export function PropertiesTab({ defs, initialSelected }: { defs: PropertyDefDTO[]; initialSelected?: string | undefined }) {
  const toast = useToast();
  const confirm = useConfirm();
  const live = defs.filter((d) => !d.archived);
  const archived = defs.filter((d) => d.archived);
  const [selectedId, setSelectedId] = useState<string | null>(() => live.find((d) => d.id === initialSelected)?.id ?? live.find((d) => d.preset === 'knowledge')?.id ?? null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const selected = live.find((d) => d.id === selectedId) ?? null;

  const call = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      invalidateWrites();
      if (ok) toast(ok, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const update = (d: PropertyDefDTO, body: Record<string, unknown>, ok?: string) => call(() => sendJSON('PUT', `/api/properties/${d.id}`, body), ok);
  const usage = useQuery({ queryKey: ['manage', 'property-usage'], queryFn: () => getJSON<Record<string, UsageDTO>>('/api/properties/usage') });
  /** “用在”题目/资料：关掉时如果已有取值，先说明取值会保留但不再显示 */
  const setApplies = async (d: PropertyDefDTO, kind: 'problem' | 'material', on: boolean) => {
    const noun = kind === 'problem' ? '题目' : '资料';
    const n = on ? 0 : (usage.data?.[d.id]?.[kind === 'problem' ? 'problems' : 'materials'] ?? 0);
    if (n > 0) {
      const ok = await confirm({
        title: `“${d.name}”不再用在${noun}上`,
        message: `已有 ${n} ${kind === 'problem' ? '道题' : '份资料'}设置了“${d.name}”。这些取值会保留，但${noun}里不再显示，也不能按它筛选和检索；重新勾选即可恢复。`,
        confirmLabel: `不再用在${noun}上`,
      });
      if (!ok) return;
    }
    await update(d, kind === 'problem' ? { appliesProblem: on } : { appliesMaterial: on });
  };
  const archive = async (d: PropertyDefDTO) => {
    const ok = await confirm({
      title: `归档属性“${d.name}”`,
      message: '归档后它不再出现在编辑页、导航与检索中；已有的取值原样保留，取消归档即可恢复。',
      confirmLabel: '归档',
    });
    if (ok) void call(() => sendJSON('POST', `/api/properties/${d.id}/archive`), '已归档');
  };
  const move = (d: PropertyDefDTO, delta: number) => {
    const ids = live.map((x) => x.id);
    const i = ids.indexOf(d.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void call(() => sendJSON('POST', '/api/properties/reorder', { ids }));
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-soft">属性出现在题目和资料的属性面板里，可以用来筛选和检索，也会写进 Markdown 导出。</p>
      <CreateForm onCreated={(d) => setSelectedId(d.id)} />
      <ul className="space-y-1.5" aria-label="属性列表">
        {live.map((d, i) => {
          const hasOptions = d.type === 'select' || d.type === 'multiselect';
          return (
            <ContextMenu key={d.id}>
              <ContextTrigger asChild>
                <li className="card-flat flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-active={selectedId === d.id || undefined}>
                  {renaming?.id === d.id ? (
                    <form
                      className="flex flex-1 items-center gap-1.5"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void update(d, { name: renaming.name }, '已改名').then(() => setRenaming(null));
                      }}
                    >
                      <input className="input py-1" value={renaming.name} autoFocus aria-label="属性新名称" onChange={(e) => setRenaming({ id: d.id, name: e.target.value })} />
                      <button type="submit" className="btn btn-sage btn-sm btn-icon" aria-label="确定">
                        <Check size={14} />
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="取消" onClick={() => setRenaming(null)}>
                        <X size={14} />
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      className={`min-w-0 flex-1 truncate text-left font-semibold ${selectedId === d.id ? 'text-sage-deep underline' : 'text-stone'}`}
                      onClick={() => setSelectedId(d.id)}
                      title={hasOptions ? '编辑选项' : undefined}
                    >
                      {d.name}
                      <span className="ml-2 text-xs font-normal text-ink-faint">
                        {PROPERTY_TYPE_LABELS[d.type]}
                        {hasOptions ? ` · ${d.options.length} 个选项` : ''}
                      </span>
                    </button>
                  )}
                  <fieldset className="flex items-center gap-2 text-xs text-ink-soft">
                    <legend className="sr-only">{d.name}用在</legend>
                    <span>用在</span>
                    {(['problem', 'material'] as const).map((kind) => {
                      const on = kind === 'problem' ? d.appliesProblem : d.appliesMaterial;
                      const other = kind === 'problem' ? d.appliesMaterial : d.appliesProblem;
                      return (
                        <label key={kind} className="flex items-center gap-1" title={on && !other ? '至少要用在题目或资料之一' : undefined}>
                          <input
                            type="checkbox"
                            className="accent-[var(--color-sage-deep)]"
                            checked={on}
                            disabled={on && !other}
                            onChange={(e) => void setApplies(d, kind, e.target.checked)}
                          />
                          {kind === 'problem' ? '题目' : '资料'}
                        </label>
                      );
                    })}
                  </fieldset>
                  {hasOptions || d.type === 'checkbox' ? (
                    <label className="flex items-center gap-1 text-xs text-ink-soft" title={NAV_HINT}>
                      <input type="checkbox" className="accent-[var(--color-sage-deep)]" checked={d.showInNav} onChange={(e) => void update(d, { showInNav: e.target.checked })} />
                      在左侧栏列出
                    </label>
                  ) : null}
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`上移 ${d.name}`} disabled={i === 0} onClick={() => move(d, -1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`下移 ${d.name}`} disabled={i === live.length - 1} onClick={() => move(d, 1)}>
                    <ArrowDown size={14} />
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRenaming({ id: d.id, name: d.name })}>
                    <Pencil size={14} /> 改名
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(d.preset)} title={d.preset ? PRESET_ARCHIVE_HINT : undefined} onClick={() => void archive(d)}>
                    <Archive size={14} /> 归档
                  </button>
                </li>
              </ContextTrigger>
              <ContextContent>
                {hasOptions ? (
                  <ContextItem onSelect={() => setSelectedId(d.id)}>
                    <ListTree size={13} /> 编辑选项
                  </ContextItem>
                ) : null}
                <ContextItem onSelect={() => setRenaming({ id: d.id, name: d.name })}>
                  <Pencil size={13} /> 改名
                </ContextItem>
                {hasOptions || d.type === 'checkbox' ? (
                  <ContextItem onSelect={() => void update(d, { showInNav: !d.showInNav }, d.showInNav ? '已不在左侧栏列出' : '已在左侧栏列出')}>
                    {d.showInNav ? <EyeOff size={13} /> : <Eye size={13} />} {d.showInNav ? '不在左侧栏列出' : '在左侧栏列出'}
                  </ContextItem>
                ) : null}
                <ContextItem onSelect={() => move(d, -1)} disabled={i === 0}>
                  <ArrowUp size={13} /> 上移
                </ContextItem>
                <ContextItem onSelect={() => move(d, 1)} disabled={i === live.length - 1}>
                  <ArrowDown size={13} /> 下移
                </ContextItem>
                <ContextSeparator />
                <ContextItem danger disabled={Boolean(d.preset)} onSelect={() => void archive(d)}>
                  <Archive size={13} /> {d.preset ? '归档（内置属性不能归档）' : '归档'}
                </ContextItem>
              </ContextContent>
            </ContextMenu>
          );
        })}
      </ul>
      {archived.length ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-soft">已归档的属性（{archived.length}）</summary>
          <ul className="mt-2 space-y-1.5">
            {archived.map((d) => (
              <li key={d.id} className="card-flat flex items-center gap-2 px-3 py-2">
                <span className="flex-1 text-ink-soft">
                  {d.name} <span className="text-xs text-ink-faint">{PROPERTY_TYPE_LABELS[d.type]}</span>
                </span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => void call(() => sendJSON('POST', `/api/properties/${d.id}/unarchive`), '已取消归档')}>
                  <ArchiveRestore size={14} /> 取消归档
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {selected && (selected.type === 'select' || selected.type === 'multiselect') ? (
        <section className="space-y-2" aria-label={`${selected.name}的选项`}>
          <h2 className="text-lg font-semibold text-stone">“{selected.name}”的选项</h2>
          <OptionTreeEditor def={selected} />
        </section>
      ) : null}
    </div>
  );
}
