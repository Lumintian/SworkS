/**
 * 数据管理：学科、学段（候选排序、改名、合并、清除）与标签（按路径改名/移动、合并、删除）。
 * 会改动题目或资料的操作都先确认影响范围；服务端在同一事务里递增受影响对象的版本。
 */
import { useQuery } from '@tanstack/react-query';
import { ArrowUpToLine, Eraser, Eye, Merge, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { DictEntryDTO, DictKind, DictManageDTO, PropertyDefDTO, TagManageDTO, TagRenameResultDTO, UsageDTO } from '@shared/api';
import { buildTagTree, flattenTagTree, inSubtree, splitTagPath, tagKey } from '@shared/tagPath';
import { TagPicker } from '../components/list/TagPicker';
import { DuplicateHint, findDuplicates } from '../components/manage/DuplicateHint';
import { ManageTree, type ManageNode } from '../components/manage/ManageTree';
import { NO_USAGE, scopeText, sumUsage, UNDO_HINT, usage, used } from '../components/manage/usage';
import { useUndoToast } from '../components/manage/useUndoToast';
import { Dialog, ErrorBox, PageHeader, Spinner, useConfirm, useToast } from '../components/ui';
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

const usageOf = (e: DictEntryDTO): UsageDTO => ({ problems: e.problemCount, materials: e.materialCount, trashed: e.trashedCount });

/** 选择合并目标：列出其他值，也可以直接输入一个新名称。 */
function DictMergeDialog({
  open,
  label,
  sources,
  entries,
  onPick,
  onClose,
}: {
  open: boolean;
  label: string;
  sources: DictEntryDTO[];
  entries: DictEntryDTO[];
  onPick: (into: string) => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const src = new Set(sources.map((s) => s.value));
  const others = entries.filter((e) => !src.has(e.value));
  return (
    <Dialog open={open} onClose={onClose} title={`把 ${sources.length} 个${label}合并到…`}>
      <div className="space-y-3 text-sm">
        <p className="text-ink-soft">所选的值在题目与资料上都会改为目标值，并从候选中移除。</p>
        <ul className="flex flex-wrap gap-1.5" aria-label="合并目标">
          {others.map((e) => (
            <li key={e.value}>
              <button type="button" className="btn btn-sm" onClick={() => onPick(e.value)}>
                <Merge size={13} /> {e.value}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed.trim()) onPick(typed.trim());
          }}
        >
          <input className="input" value={typed} maxLength={50} placeholder={`或输入新的${label}名称`} aria-label={`合并到新的${label}`} onChange={(e) => setTyped(e.target.value)} />
          <button type="submit" className="btn btn-sage" disabled={!typed.trim()}>
            合并
          </button>
        </form>
      </div>
    </Dialog>
  );
}

interface DictNode extends ManageNode {
  entry: DictEntryDTO;
  usage: UsageDTO;
}

type Undoable = { undoId?: string };

function DictTab({ kind, entries }: { kind: DictKind; entries: DictEntryDTO[] }) {
  const toast = useToast();
  const undoToast = useUndoToast();
  const confirm = useConfirm();
  const { navigate } = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [merging, setMerging] = useState<DictEntryDTO[] | null>(null);
  const [adding, setAdding] = useState('');
  const label = KIND_LABEL[kind];
  const inDict = entries.filter((e) => e.inDict).map((e) => e.value);
  const byValue = new Map(entries.map((e) => [e.value, e]));
  const nodes = useMemo(
    () =>
      entries.map(
        (e): DictNode => ({
          id: e.value,
          parentId: null,
          label: e.value,
          hint: `${usage(usageOf(e))}${e.inDict ? '' : ' · 不在候选中'}`,
          muted: !e.inDict,
          entry: e,
          usage: usageOf(e),
        }),
      ),
    [entries],
  );
  const duplicates = useMemo(() => findDuplicates(nodes), [nodes]);

  const call = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      invalidateWrites();
      toast(ok, 'success');
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  };
  const names = (xs: DictEntryDTO[]) => xs.map((x) => `“${x.value}”`).join('、');

  const rename = async (from: DictEntryDTO, to: string) => {
    const target = byValue.get(to);
    if (used(usageOf(from)) || target) {
      const ok = await confirm({
        title: target ? `合并到“${to}”` : `改名为“${to}”`,
        message: `${used(usageOf(from)) ? `${usage(usageOf(from))}的${label}会从“${from.value}”改为“${to}”` : `“${from.value}”会改为“${to}”`}${target ? '，两者合并为一个' : ''}。${UNDO_HINT}`,
        confirmLabel: target ? '合并' : '改名',
      });
      if (!ok) return;
    }
    try {
      const r = await sendJSON<{ affectedItems: number } & Undoable>('POST', `/api/dict/${kind}/rename`, { from: from.value, to });
      invalidateWrites();
      undoToast(`${target ? '已合并' : '已改名'}${r.affectedItems ? `，影响 ${r.affectedItems} 项` : ''}`, r.undoId);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  /** 合并到 into；into 为 null 时从所有对象上清除并移出候选。 */
  const mergeMany = async (xs: DictEntryDTO[], into: string | null) => {
    const c = sumUsage(xs.map(usageOf));
    const ok = await confirm({
      title: into === null ? `清除 ${xs.length} 个${label}` : `把 ${xs.length} 个${label}合并到“${into}”`,
      message:
        into === null
          ? `将从 ${usage(c)}上清除 ${names(xs)}，并把它们移出候选。${UNDO_HINT}`
          : `${used(c) ? `${usage(c)}的${label}会改为“${into}”，` : ''}${names(xs)}移出候选。${UNDO_HINT}`,
      confirmLabel: into === null ? '清除' : '合并',
      danger: into === null,
    });
    if (!ok) return;
    try {
      const r = await sendJSON<{ affectedItems: number } & Undoable>('POST', `/api/dict/${kind}/merge`, { values: xs.map((x) => x.value), into });
      invalidateWrites();
      undoToast(`${into === null ? '已清除' : '已合并'}，影响 ${r.affectedItems} 项`, r.undoId);
      setSelected(into === null ? [] : [into]);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const removeFromDict = async (xs: DictEntryDTO[]) => {
    if (await call(() => sendJSON('POST', `/api/dict/${kind}/remove-many`, { values: xs.map((x) => x.value) }), `已把 ${xs.length} 个值移出候选`)) setSelected([]);
  };

  /** 拖动排序：只重排候选；把不在候选中的值拖进来即加入候选。 */
  const onMove = async (ids: string[], _parent: string | null, index: number | undefined) => {
    const rest = entries.map((e) => e.value).filter((v) => !ids.includes(v));
    const at = index === undefined ? rest.length : index;
    const order = [...rest.slice(0, at), ...ids, ...rest.slice(at)].filter((v) => inDict.includes(v) || ids.includes(v));
    await call(() => sendJSON('POST', `/api/dict/${kind}/reorder`, { values: order }), '已调整顺序');
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        候选按这里的顺序出现在编辑页与导航中，拖动即可调整。单击选择，⌘/Ctrl 或 ⇧ 多选，右键或“⋯”打开菜单；F2 改名，Delete 清除所选。改名与合并会同时改写题目和资料上的取值。
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
      <DuplicateHint groups={duplicates} describe={(n) => n.entry.value} onMerge={(xs, into) => void mergeMany(xs.map((x) => x.entry), into.entry.value)} />
      <div className="card-flat px-2 py-2">
        <ManageTree<DictNode>
          label={`${label}列表`}
          filterPlaceholder={entries.length > 12 ? `过滤${label}` : undefined}
          nodes={nodes}
          selectedIds={selected}
          onSelectedIdsChange={setSelected}
          emptyText={`还没有${label}。`}
          drag={{ canReparent: false, canReorder: true, onMove }}
          rename={{ label: `${label}新名称`, initial: (n) => n.entry.value, submit: (n, v) => void rename(n.entry, v) }}
          onDelete={(sel) => {
            const xs = sel.map((n) => n.entry);
            if (!xs.some((x) => used(usageOf(x)))) void removeFromDict(xs);
            else void mergeMany(xs, null);
          }}
          actions={(sel, { startRename }) => {
            const xs = sel.map((n) => n.entry);
            const one = xs.length === 1 ? xs[0] : undefined;
            const inUse = xs.some((x) => used(usageOf(x)));
            return [
              {
                key: 'view',
                label: '在题目列表中查看',
                icon: <Eye size={13} />,
                disabled: !one,
                onSelect: () => one && navigate(`/problems?${new URLSearchParams({ [kind]: one.value }).toString()}`),
              },
              { key: 'rename', label: '改名', icon: <Pencil size={13} />, disabled: !one, onSelect: () => one && startRename(one.value) },
              ...(xs.some((x) => !x.inDict)
                ? [
                    {
                      key: 'add',
                      label: '加入候选',
                      icon: <Plus size={13} />,
                      onSelect: () =>
                        void call(
                          () => sendJSON('POST', `/api/dict/${kind}/reorder`, { values: [...inDict, ...xs.filter((x) => !x.inDict).map((x) => x.value)] }),
                          '已加入候选',
                        ),
                    },
                  ]
                : []),
              { key: 'merge', label: '合并到…', icon: <Merge size={13} />, disabled: xs.length === 0, onSelect: () => setMerging(xs) },
              inUse
                ? { key: 'clear', label: `从所有对象上清除${xs.length > 1 ? ` ${xs.length} 项` : ''}`, icon: <Trash2 size={13} />, danger: true, separatorBefore: true, onSelect: () => void mergeMany(xs, null) }
                : { key: 'remove', label: `移出候选${xs.length > 1 ? ` ${xs.length} 项` : ''}`, icon: <Trash2 size={13} />, danger: true, separatorBefore: true, disabled: xs.length === 0, onSelect: () => void removeFromDict(xs) },
            ];
          }}
        />
      </div>
      <DictMergeDialog
        open={merging !== null}
        label={label}
        sources={merging ?? []}
        entries={entries}
        onClose={() => setMerging(null)}
        onPick={(into) => {
          const xs = merging ?? [];
          setMerging(null);
          void mergeMany(xs, into);
        }}
      />
    </div>
  );
}

interface TagNode extends ManageNode {
  path: string;
  usage: UsageDTO;
}

function TagsTab({ data }: { data: TagManageDTO }) {
  const toast = useToast();
  const undoToast = useUndoToast();
  const confirm = useConfirm();
  const { navigate } = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [merging, setMerging] = useState<TagNode[] | null>(null);
  // 计数由服务端按不重复的对象汇总到每个节点；只在数据变化时重建节点（选择变化不重算）
  const nodes = useMemo(
    () =>
      flattenTagTree(buildTagTree(data.tags)).map((n): TagNode => {
        const u = data.usage[n.key] ?? NO_USAGE;
        const parentKey = n.key.includes('/') ? n.key.slice(0, n.key.lastIndexOf('/')) : null;
        return { id: n.key, parentId: parentKey, label: n.name, hint: usage(u), muted: n.tagIds.length === 0, path: n.path, usage: u };
      }),
    [data],
  );
  const tagNames = useMemo(() => data.tags.map((t) => t.name), [data]);
  const duplicates = useMemo(() => findDuplicates(nodes), [nodes]);
  /** 没有任何对象（含回收站中的）在用的标签行：编辑页里删掉最后一处用法后留下的 */
  const unused = useMemo(() => data.tags.filter((t) => !t.used), [data]);
  const byKey = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  /** 只保留最上层：父子同时选中时按父级处理。 */
  const topmost = (xs: TagNode[]) => xs.filter((x) => !xs.some((y) => y !== x && x.id.startsWith(`${y.id}/`)));
  const scope = (xs: TagNode[]) => scopeText(xs.map((x) => x.usage));
  const names = (xs: TagNode[]) => (xs.length <= 3 ? xs.map((x) => `“${x.path}”`).join('、') : `“${xs[0]!.path}”等 ${xs.length} 个标签`);

  const report = (r: TagRenameResultDTO, verb: string) => {
    invalidateWrites();
    undoToast(`${verb}：改名 ${r.renamed} 个、合并 ${r.merged} 个标签，影响 ${r.affectedItems} 项`, r.undoId);
  };

  const rename = async (n: TagNode, to: string) => {
    const ok = await confirm({
      title: `把“${n.path}”改为“${to}”`,
      message: `连同下级标签一起改名，与已有标签同名时自动合并。${used(n.usage) ? `涉及 ${usage(n.usage)}。` : ''}${UNDO_HINT}`,
      confirmLabel: '改名',
    });
    if (!ok) return;
    try {
      report(await sendJSON<TagRenameResultDTO>('POST', '/api/tags/rename', { from: n.path, to }), '已改名');
      setSelected([tagKey(to)]);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const remove = async (sel: TagNode[]) => {
    const xs = topmost(sel);
    if (xs.length === 0) return;
    const ok = await confirm({
      title: xs.length === 1 ? `删除标签“${xs[0]!.path}”` : `删除 ${xs.length} 个标签`,
      message: `${names(xs)}连同下级标签一起删除。${scope(xs) ? `会从 ${scope(xs)}上移除，题目和资料本身不受影响。` : ''}${UNDO_HINT}`,
      confirmLabel: xs.length === 1 ? '删除标签' : `删除 ${xs.length} 个标签`,
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await sendJSON<{ deleted: number; affectedItems: number } & Undoable>('POST', '/api/tags/delete-many', { paths: xs.map((x) => x.path) });
      invalidateWrites();
      undoToast(`已删除 ${r.deleted} 个标签，影响 ${r.affectedItems} 项`, r.undoId);
      setSelected([]);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const merge = async (sel: TagNode[], into: string) => {
    const xs = topmost(sel);
    const ok = await confirm({
      title: `把 ${xs.length} 个标签合并到“${into}”`,
      message: `${names(xs)}（连同下级）会改为“${into}”，与已有标签重名的自动合并。${scope(xs) ? `涉及 ${scope(xs)}。` : ''}${UNDO_HINT}`,
      confirmLabel: '合并',
    });
    if (!ok) return;
    try {
      report(await sendJSON<TagRenameResultDTO>('POST', '/api/tags/merge', { from: xs.map((x) => x.path), to: into }), '已合并');
      setSelected([tagKey(into)]);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  /** 移动后会与已有标签（或一起移动的其他标签）同名、从而合并掉的标签路径。 */
  const mergesOnMove = (xs: TagNode[], parent: TagNode | null): string[] => {
    const moving = (k: string) => xs.some((x) => inSubtree(k, x.id));
    const taken = new Set(data.tags.map((t) => tagKey(t.name)).filter((k) => !moving(k)));
    const out: string[] = [];
    for (const x of xs) {
      const to = parent ? `${parent.path}/${x.label}` : x.label;
      for (const t of data.tags) {
        const k = tagKey(t.name);
        if (!inSubtree(k, x.id)) continue;
        const next = tagKey(to) + k.slice(x.id.length);
        if (next === k) continue;
        if (taken.has(next)) out.push([to, ...splitTagPath(t.name).slice(splitTagPath(x.path).length)].join('/'));
        taken.add(next);
      }
    }
    return out;
  };

  const cleanUnused = async () => {
    const ok = await confirm({
      title: `删除 ${unused.length} 个没人用的标签`,
      message: `${unused
        .slice(0, 5)
        .map((t) => `“${t.name}”`)
        .join('、')}${unused.length > 5 ? ` 等 ${unused.length} 个` : ''}没有挂在任何题目或资料上（回收站里的也没有），删除不影响任何内容。${UNDO_HINT}`,
      confirmLabel: '删除',
    });
    if (!ok) return;
    try {
      const r = await sendJSON<{ deleted: number } & Undoable>('POST', '/api/tags/delete-unused', { ids: unused.map((t) => t.id) });
      invalidateWrites();
      undoToast(`已删除 ${r.deleted} 个没人用的标签`, r.undoId);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const moveTo = async (sel: TagNode[], parent: TagNode | null) => {
    const xs = topmost(sel);
    const merges = mergesOnMove(xs, parent);
    if (merges.length) {
      const ok = await confirm({
        title: '移动后会合并同名标签',
        message: `移到${parent ? `“${parent.path}”下` : '顶层'}后，${merges
          .slice(0, 3)
          .map((m) => `“${m}”`)
          .join('、')}${merges.length > 3 ? ` 等 ${merges.length} 个` : ''}与已有标签同名，会合并为一个。${scope(xs) ? `涉及 ${scope(xs)}。` : ''}${UNDO_HINT}`,
        confirmLabel: '移动并合并',
      });
      if (!ok) return;
    }
    try {
      report(await sendJSON<TagRenameResultDTO>('POST', '/api/tags/move', { paths: xs.map((x) => x.path), parent: parent?.path ?? null }), '已移动');
      setSelected([]);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-soft">
        标签用 <code className="rounded bg-sunken px-1">/</code> 分层，例如“方法/换元”。单击选择，⌘/Ctrl 或 ⇧ 多选，右键或“⋯”打开菜单；F2 改名（写完整路径即可移动），把标签拖到另一个标签上即移到它下面，Delete 删除所选。新名称与已有标签相同时会合并。
      </p>
      {unused.length ? (
        <div className="flex flex-wrap items-center gap-2 border border-line bg-sunken px-3 py-2 text-sm text-ink-soft" style={{ borderRadius: 'var(--radius-organic-sm)' }}>
          <span className="flex-1">{unused.length} 个标签没有挂在任何题目或资料上（显示为“未使用”）。</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void cleanUnused()}>
            <Eraser size={13} /> 全部删除
          </button>
        </div>
      ) : null}
      <DuplicateHint groups={duplicates} describe={(n) => n.path} onMerge={(xs, into) => void merge(xs, into.path)} />
      <div className="card-flat max-h-[70vh] overflow-y-auto px-2 py-2">
        <ManageTree<TagNode>
          label="标签树"
          filterPlaceholder="过滤标签，例如“方法/换元”"
          nodes={nodes}
          selectedIds={selected}
          onSelectedIdsChange={setSelected}
          expandAll
          emptyText="还没有标签。"
          drag={{
            canReparent: true,
            canReorder: false,
            onMove: (ids, parentId) => moveTo(ids.map((id) => byKey.get(id)!).filter(Boolean), parentId ? (byKey.get(parentId) ?? null) : null),
          }}
          rename={{ label: '标签新路径', initial: (n) => n.path, submit: (n, v) => void rename(n, v) }}
          onDelete={(sel) => void remove(sel)}
          actions={(sel, { startRename }) => {
            const one = sel.length === 1 ? sel[0] : undefined;
            return [
              {
                key: 'view',
                label: '在题目列表中查看',
                icon: <Eye size={13} />,
                disabled: !one,
                onSelect: () => one && navigate(`/problems?${new URLSearchParams({ tag: one.path }).toString()}`),
              },
              { key: 'rename', label: '改名/移动', icon: <Pencil size={13} />, disabled: !one, onSelect: () => one && startRename(one.id) },
              { key: 'top', label: '移到顶层', icon: <ArrowUpToLine size={13} />, disabled: !sel.some((x) => x.parentId !== null), onSelect: () => void moveTo(sel, null) },
              { key: 'merge', label: '合并到…', icon: <Merge size={13} />, disabled: sel.length === 0, onSelect: () => setMerging(sel) },
              {
                key: 'delete',
                label: sel.length > 1 ? `删除 ${topmost(sel).length} 个标签` : '删除',
                icon: <Trash2 size={13} />,
                danger: true,
                separatorBefore: true,
                disabled: sel.length === 0,
                onSelect: () => void remove(sel),
              },
            ];
          }}
        />
      </div>
      <Dialog open={merging !== null} onClose={() => setMerging(null)} title={`把 ${merging?.length ?? 0} 个标签合并到…`}>
        <TagPicker
          tags={tagNames}
          placeholder="选择或输入目标标签…"
          onPick={(into) => {
            const xs = merging ?? [];
            setMerging(null);
            void merge(xs, into);
          }}
        />
      </Dialog>
    </div>
  );
}

export function ManagePage() {
  const { search, navigate, path } = useRouter();
  const raw = new URLSearchParams(search).get('tab');
  const tab: Tab = TABS.some((t) => t.id === raw) ? (raw as Tab) : 'properties';
  // 只请求当前页签的数据
  const dict = useQuery({ queryKey: ['manage', 'dict'], queryFn: () => getJSON<DictManageDTO>('/api/dict/manage'), enabled: tab === 'subject' || tab === 'stage' });
  const tags = useQuery({ queryKey: ['manage', 'tags'], queryFn: () => getJSON<TagManageDTO>('/api/tags/manage'), enabled: tab === 'tags' });
  const props = useQuery({ queryKey: ['manage', 'properties'], queryFn: () => getJSON<PropertyDefDTO[]>('/api/properties?all=1'), enabled: tab === 'properties' });
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
      {tab === 'tags' && tags.data ? <TagsTab data={tags.data} /> : null}
      {(tab === 'subject' || tab === 'stage') && dict.data ? <DictTab kind={tab} entries={dict.data[tab]} /> : null}
    </div>
  );
}
