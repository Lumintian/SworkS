/**
 * 数据管理 → 属性：新建自定义属性（名称、类型、是否分层、适用范围），
 * 调整顺序、改名、导航显示、归档（也可右键打开菜单）；选中单选/多选属性后编辑它的选项树。
 */
import { ArrowDown, ArrowUp, Archive, ArchiveRestore, Check, Eye, EyeOff, ListTree, Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { PropertyDefDTO } from '@shared/api';
import { PROPERTY_TYPE_LABELS, PROPERTY_TYPES, type PropertyType } from '@shared/constants';
import { ContextContent, ContextItem, ContextMenu, ContextSeparator, ContextTrigger } from '../components/Menu';
import { OptionTreeEditor } from '../components/props/OptionTreeEditor';
import { useConfirm, useToast } from '../components/ui';
import { errorMessage, sendJSON } from '../lib/api';
import { newId } from '../lib/format';
import { CATALOG_ONLY, invalidateWrites } from '../lib/queryClient';

const PRESET_HINT: Record<string, string> = {
  qtype: '预置，可分层，可按它排序',
  difficulty: '预置，可按它排序',
  knowledge: '预置考点树',
};

function CreateForm({ onCreated }: { onCreated: (d: PropertyDefDTO) => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [type, setType] = useState<PropertyType>('select');
  const [nested, setNested] = useState(false);
  const [problem, setProblem] = useState(true);
  const [material, setMaterial] = useState(false);
  const optionType = type === 'select' || type === 'multiselect';
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
            nested: optionType && nested,
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
        <select className="select w-auto" value={type} onChange={(e) => setType(e.target.value as PropertyType)}>
          {PROPERTY_TYPES.map((t) => (
            <option key={t} value={t}>
              {PROPERTY_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      {optionType ? (
        <label className="flex items-center gap-1.5 pb-2">
          <input type="checkbox" className="accent-[var(--color-sage-deep)]" checked={nested} onChange={(e) => setNested(e.target.checked)} />
          选项分层（树）
        </label>
      ) : null}
      <fieldset className="flex items-center gap-3 pb-2">
        <legend className="sr-only">适用于</legend>
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
    </form>
  );
}

export function PropertiesTab({ defs }: { defs: PropertyDefDTO[] }) {
  const toast = useToast();
  const confirm = useConfirm();
  const live = defs.filter((d) => !d.archived);
  const archived = defs.filter((d) => d.archived);
  const [selectedId, setSelectedId] = useState<string | null>(() => live.find((d) => d.preset === 'knowledge')?.id ?? null);
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
      <p className="text-sm text-ink-soft">
        属性出现在题目与资料的属性面板、导航与筛选中，也会写入 Markdown 导出。选项按 ID 保存：改名、调整层级不会改动题目内容；删除或合并选项会同步修改用到它的题目。
      </p>
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
                        {d.preset ? ` · ${PRESET_HINT[d.preset]}` : ''}
                      </span>
                    </button>
                  )}
                  <label className="flex items-center gap-1 text-xs text-ink-soft">
                    <input type="checkbox" className="accent-[var(--color-sage-deep)]" checked={d.appliesProblem} onChange={(e) => void update(d, { appliesProblem: e.target.checked })} />
                    题目
                  </label>
                  <label className="flex items-center gap-1 text-xs text-ink-soft">
                    <input type="checkbox" className="accent-[var(--color-sage-deep)]" checked={d.appliesMaterial} onChange={(e) => void update(d, { appliesMaterial: e.target.checked })} />
                    资料
                  </label>
                  {hasOptions ? (
                    <label className="flex items-center gap-1 text-xs text-ink-soft" title="选项可以有上下级，例如“英语/完型填空”">
                      <input
                        type="checkbox"
                        className="accent-[var(--color-sage-deep)]"
                        checked={d.nested}
                        aria-label={`${d.name}的选项分层`}
                        onChange={(e) => void update(d, { nested: e.target.checked }, e.target.checked ? `“${d.name}”的选项可以分层了` : `“${d.name}”的选项已取消分层`)}
                      />
                      分层
                    </label>
                  ) : null}
                  {hasOptions || d.type === 'checkbox' ? (
                    <label className="flex items-center gap-1 text-xs text-ink-soft">
                      <input type="checkbox" className="accent-[var(--color-sage-deep)]" checked={d.showInNav} onChange={(e) => void update(d, { showInNav: e.target.checked })} />
                      导航显示
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
                  {d.preset ? null : (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void archive(d)}>
                      <Archive size={14} /> 归档
                    </button>
                  )}
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
                  <ContextItem onSelect={() => void update(d, { showInNav: !d.showInNav }, d.showInNav ? '已从导航中隐藏' : '已在导航中显示')}>
                    {d.showInNav ? <EyeOff size={13} /> : <Eye size={13} />} {d.showInNav ? '不在导航中显示' : '在导航中显示'}
                  </ContextItem>
                ) : null}
                <ContextItem onSelect={() => move(d, -1)} disabled={i === 0}>
                  <ArrowUp size={13} /> 上移
                </ContextItem>
                <ContextItem onSelect={() => move(d, 1)} disabled={i === live.length - 1}>
                  <ArrowDown size={13} /> 下移
                </ContextItem>
                {d.preset ? null : (
                  <>
                    <ContextSeparator />
                    <ContextItem danger onSelect={() => void archive(d)}>
                      <Archive size={13} /> 归档
                    </ContextItem>
                  </>
                )}
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
