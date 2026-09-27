/**
 * 数据管理：学科、学段（候选排序、改名、合并、清除）与标签（按路径改名/移动、合并、删除）。
 * 会改动题目或资料的操作都先确认影响范围；服务端在同一事务里递增受影响对象的版本。
 */
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, ChevronDown, Merge, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { DictEntryDTO, DictKind, DictManageDTO, PropertyDefDTO, TagDTO, TagRenameResultDTO } from '@shared/api';
import { buildTagTree, flattenTagTree, tagKey, type TagTreeNode } from '@shared/tagPath';
import { DropdownContent, DropdownItem, DropdownLabel, DropdownMenu, DropdownSeparator, DropdownTrigger } from '../components/Menu';
import { ErrorBox, PageHeader, Spinner, useConfirm, useToast } from '../components/ui';
import { errorMessage, getJSON, sendJSON } from '../lib/api';
import { invalidateWrites } from '../lib/queryClient';
import { useRouter } from '../lib/router';
import { PropertiesTab } from './PropertiesTab';

type Tab = 'subject' | 'stage' | 'tags' | 'properties';
const TABS: { id: Tab; label: string }[] = [
  { id: 'properties', label: '属性与考点' },
  { id: 'subject', label: '学科' },
  { id: 'stage', label: '学段' },
  { id: 'tags', label: '标签' },
];
const KIND_LABEL: Record<DictKind, string> = { subject: '学科', stage: '学段' };

function usage(p: number, m: number): string {
  const parts = [];
  if (p) parts.push(`${p} 道题`);
  if (m) parts.push(`${m} 份资料`);
  return parts.length ? parts.join('、') : '未使用';
}

function InlineEdit({ initial, label, onSubmit, onCancel }: { initial: string; label: string; onSubmit: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim() && v.trim() !== initial) onSubmit(v.trim());
        else onCancel();
      }}
    >
      <input className="input py-1" value={v} autoFocus aria-label={label} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onCancel()} />
      <button type="submit" className="btn btn-sage btn-sm btn-icon" aria-label="确定">
        <Check size={14} />
      </button>
      <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="取消" onClick={onCancel}>
        <X size={14} />
      </button>
    </form>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <li className="card-flat flex flex-wrap items-center gap-2 px-3 py-2 text-sm">{children}</li>;
}

function DictTab({ kind, entries }: { kind: DictKind; entries: DictEntryDTO[] }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const label = KIND_LABEL[kind];
  const inDict = entries.filter((e) => e.inDict).map((e) => e.value);

  const call = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      invalidateWrites();
      toast(ok, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const rename = async (from: DictEntryDTO, to: string | null) => {
    const n = from.problemCount + from.materialCount;
    const target = to === null ? null : entries.find((e) => e.value === to);
    if (n > 0 || target) {
      const ok = await confirm({
        title: to === null ? `清除${label}“${from.value}”` : target ? `合并到“${to}”` : `改名为“${to}”`,
        message:
          to === null
            ? `将从 ${usage(from.problemCount, from.materialCount)}上清除“${from.value}”，并把它移出候选。`
            : `${usage(from.problemCount, from.materialCount)}的${label}会从“${from.value}”改为“${to}”${target ? '，两者合并为一个' : ''}。仍打开着的编辑页需要重新加载才能保存。`,
        confirmLabel: to === null ? '清除' : target ? '合并' : '改名',
        danger: to === null,
      });
      if (!ok) return;
    }
    await call(() => sendJSON('POST', `/api/dict/${kind}/rename`, { from: from.value, to }), to === null ? '已清除' : target ? '已合并' : '已改名');
    setEditing(null);
  };

  const move = (value: string, delta: number) => {
    const order = [...inDict];
    const i = order.indexOf(value);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j]!, order[i]!];
    void call(() => sendJSON('POST', `/api/dict/${kind}/reorder`, { values: order }), '已调整顺序');
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        候选按这里的顺序出现在编辑页与导航中。改名与合并会同时改写题目和资料上的取值；不在候选中但有对象使用的值显示在下方，可以加入候选或合并到其他值。
      </p>
      <form
        className="flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const v = adding.trim();
          if (!v) return;
          void call(() => sendJSON('POST', `/api/dict/${kind}/add`, { value: v }), `已添加${label}“${v}”`).then(() => setAdding(''));
        }}
      >
        <input className="input" value={adding} maxLength={50} placeholder={`新${label}名称`} aria-label={`新${label}名称`} onChange={(e) => setAdding(e.target.value)} />
        <button type="submit" className="btn btn-sage" disabled={!adding.trim()}>
          <Plus size={15} /> 添加
        </button>
      </form>
      <ul className="space-y-1.5" aria-label={`${label}列表`}>
        {entries.map((e) => (
          <Row key={e.value}>
            {editing === e.value ? (
              <InlineEdit initial={e.value} label={`${label}新名称`} onSubmit={(v) => void rename(e, v)} onCancel={() => setEditing(null)} />
            ) : (
              <>
                <span className={`min-w-0 flex-1 truncate font-semibold ${e.inDict ? 'text-stone' : 'text-ink-soft'}`} onDoubleClick={() => setEditing(e.value)}>
                  {e.value}
                  {e.inDict ? null : <span className="chip chip-warn ml-2 font-normal">不在候选中</span>}
                </span>
                <span className="text-xs text-ink-faint">{usage(e.problemCount, e.materialCount)}</span>
                {e.inDict ? (
                  <>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={`上移 ${e.value}`} disabled={inDict.indexOf(e.value) === 0} onClick={() => move(e.value, -1)}>
                      <ArrowUp size={14} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm btn-icon"
                      aria-label={`下移 ${e.value}`}
                      disabled={inDict.indexOf(e.value) === inDict.length - 1}
                      onClick={() => move(e.value, 1)}
                    >
                      <ArrowDown size={14} />
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => void call(() => sendJSON('POST', `/api/dict/${kind}/add`, { value: e.value }), '已加入候选')}>
                    <Plus size={14} /> 加入候选
                  </button>
                )}
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(e.value)}>
                  <Pencil size={14} /> 改名
                </button>
                <DropdownMenu>
                  <DropdownTrigger asChild>
                    <button type="button" className="btn btn-ghost btn-sm">
                      更多 <ChevronDown size={13} />
                    </button>
                  </DropdownTrigger>
                  <DropdownContent align="end">
                    <DropdownLabel>合并到</DropdownLabel>
                    {entries
                      .filter((x) => x.value !== e.value)
                      .map((x) => (
                        <DropdownItem key={x.value} onSelect={() => void rename(e, x.value)}>
                          <Merge size={13} /> {x.value}
                        </DropdownItem>
                      ))}
                    <DropdownSeparator />
                    {e.problemCount + e.materialCount > 0 ? (
                      <DropdownItem danger onSelect={() => void rename(e, null)}>
                        <Trash2 size={13} /> 从所有对象上清除
                      </DropdownItem>
                    ) : e.inDict ? (
                      <DropdownItem danger onSelect={() => void call(() => sendJSON('POST', `/api/dict/${kind}/remove`, { value: e.value }), '已移出候选')}>
                        <Trash2 size={13} /> 移出候选
                      </DropdownItem>
                    ) : null}
                  </DropdownContent>
                </DropdownMenu>
              </>
            )}
          </Row>
        ))}
      </ul>
    </div>
  );
}

function TagsTab({ tags }: { tags: TagDTO[] }) {
  const toast = useToast();
  const confirm = useConfirm();
  const { navigate } = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const tree = buildTagTree(tags);
  const nodes = flattenTagTree(tree);
  const depth = (n: TagTreeNode) => n.key.split('/').length - 1;
  const counts = (n: TagTreeNode) => {
    let p = 0;
    let m = 0;
    for (const t of tags) {
      const k = tagKey(t.name);
      if (k === n.key || k.startsWith(`${n.key}/`)) {
        p += t.problemCount;
        m += t.materialCount;
      }
    }
    return { p, m };
  };

  const rename = async (n: TagTreeNode, to: string) => {
    const c = counts(n);
    const ok = await confirm({
      title: `把“${n.path}”改为“${to}”`,
      message: `连同下级标签一起改名（与已有标签同名时自动合并）。涉及约 ${usage(c.p, c.m)}；仍打开着的编辑页需要重新加载才能保存。`,
      confirmLabel: '改名',
    });
    if (!ok) return;
    try {
      const r = await sendJSON<TagRenameResultDTO>('POST', '/api/tags/rename', { from: n.path, to });
      invalidateWrites();
      toast(`已改名 ${r.renamed} 个、合并 ${r.merged} 个标签，影响 ${r.affectedItems} 项`, 'success');
      setEditing(null);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const remove = async (n: TagTreeNode) => {
    const c = counts(n);
    const ok = await confirm({
      title: `删除标签“${n.path}”`,
      message: `连同下级标签一起删除，并从 ${usage(c.p, c.m)}（含回收站中的）上移除。题目和资料本身不受影响。`,
      confirmLabel: '删除标签',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await sendJSON<{ deleted: number; affectedItems: number }>('POST', '/api/tags/delete', { path: n.path });
      invalidateWrites();
      toast(`已删除 ${r.deleted} 个标签，影响 ${r.affectedItems} 项`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        标签用 <code className="rounded bg-sunken px-1">/</code> 分层，例如“方法/换元”。改名时填写完整路径即可移动到别的上级下；新名称与已有标签相同时会合并。
      </p>
      {nodes.length === 0 ? <p className="text-sm text-ink-faint">还没有标签。</p> : null}
      <ul className="space-y-1.5" aria-label="标签树">
        {nodes.map((n) => {
          const c = counts(n);
          return (
            <Row key={n.key}>
              <span style={{ width: `${depth(n) * 1.25}rem` }} className="flex-none" aria-hidden="true" />
              {editing === n.key ? (
                <InlineEdit initial={n.path} label="标签新路径" onSubmit={(v) => void rename(n, v)} onCancel={() => setEditing(null)} />
              ) : (
                <>
                  <button
                    type="button"
                    className={`min-w-0 flex-1 truncate text-left font-semibold ${n.tagIds.length ? 'text-stone' : 'text-ink-soft'}`}
                    title={`查看带“${n.path}”的题目`}
                    onClick={() => navigate(`/problems?${new URLSearchParams({ tag: n.path }).toString()}`)}
                    onDoubleClick={() => setEditing(n.key)}
                  >
                    {n.name}
                    {depth(n) > 0 ? <span className="ml-2 text-xs font-normal text-ink-faint">{n.path}</span> : null}
                  </button>
                  <span className="text-xs text-ink-faint">{usage(c.p, c.m)}</span>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(n.key)}>
                    <Pencil size={14} /> 改名/移动
                  </button>
                  <button type="button" className="btn btn-ghost btn-sm hover:!text-terracotta" onClick={() => void remove(n)}>
                    <Trash2 size={14} /> 删除
                  </button>
                </>
              )}
            </Row>
          );
        })}
      </ul>
    </div>
  );
}

export function ManagePage() {
  const { search, navigate, path } = useRouter();
  const raw = new URLSearchParams(search).get('tab');
  const tab: Tab = TABS.some((t) => t.id === raw) ? (raw as Tab) : 'properties';
  const dict = useQuery({ queryKey: ['manage', 'dict'], queryFn: () => getJSON<DictManageDTO>('/api/dict/manage') });
  const tags = useQuery({ queryKey: ['manage', 'tags'], queryFn: () => getJSON<TagDTO[]>('/api/tags?all=1') });
  const props = useQuery({ queryKey: ['manage', 'properties'], queryFn: () => getJSON<PropertyDefDTO[]>('/api/properties?all=1') });
  const q = tab === 'tags' ? tags : tab === 'properties' ? props : dict;
  return (
    <div>
      <PageHeader title="数据管理" subtitle="管理自定义属性与考点树、学科、学段与标签：改名、合并、排序与删除。改动题目内容的操作会记录到对应题目与资料的修改时间。" />
      <div className="segmented mb-4" role="tablist" aria-label="数据类别">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => navigate(`${path}?tab=${t.id}`, { replace: true })}>
            {t.label}
          </button>
        ))}
      </div>
      {q.isPending ? <Spinner /> : null}
      {q.isError ? <ErrorBox message={errorMessage(q.error)} onRetry={() => void q.refetch()} /> : null}
      {tab === 'properties' && props.data ? <PropertiesTab defs={props.data} /> : null}
      {tab === 'tags' && tags.data ? <TagsTab tags={tags.data} /> : null}
      {(tab === 'subject' || tab === 'stage') && dict.data ? <DictTab kind={tab} entries={dict.data[tab]} /> : null}
    </div>
  );
}
