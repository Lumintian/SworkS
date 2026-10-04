/**
 * 数据管理 → 标签：按路径成树；改名（写完整路径即可移动）、拖到别的标签下、合并、删除（含子树）；
 * 疑似重复与没人用的标签行给出提示。会改动题目或资料的操作都先确认影响范围，完成后可以撤销。
 */
import { ArrowUpToLine, Eraser, Eye, Merge, Pencil, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { TagManageDTO, TagRenameResultDTO, UsageDTO } from '@shared/api';
import { buildTagTree, flattenTagTree, inSubtree, splitTagPath, tagKey } from '@shared/tagPath';
import { errorMessage, sendJSON } from '../../lib/api';
import { invalidateWrites } from '../../lib/queryClient';
import { useRouter } from '../../lib/router';
import { TagPicker } from '../list/TagPicker';
import { Dialog, useConfirm, useToast } from '../ui';
import { DuplicateHint, findDuplicates } from './DuplicateHint';
import { ManageHelp, treeTips } from './ManageHelp';
import { ManageTree, type ManageNode } from './ManageTree';
import { NO_USAGE, scopeText, UNDO_HINT, usage, used } from './usage';
import { useUndoToast } from './useUndoToast';

type Undoable = { undoId?: string };

interface TagNode extends ManageNode {
  path: string;
  usage: UsageDTO;
}

export function TagsPanel({ data }: { data: TagManageDTO }) {
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
      const r = await sendJSON<TagRenameResultDTO>('POST', '/api/tags/rename', { from: n.path, to });
      invalidateWrites();
      undoToast(`已改名 ${r.renamed} 个、合并 ${r.merged} 个标签，影响 ${r.affectedItems} 项`, r.undoId);
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
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm text-ink-soft">
          标签用 <code className="rounded bg-sunken px-1">/</code> 分层，例如“方法/换元”。改名、移动、删除会同时改写题目和资料上的标签。
        </p>
        <ManageHelp
          title="标签树"
          tips={[
            ...treeTips({ drag: '把标签拖到另一个标签上，即移到它下面（连同下级）' }),
            '改名时写完整路径即可移到别的上级下，例如把“换元”改成“方法/换元”',
            '新名称与已有标签相同时，两者合并为一个',
          ]}
        />
      </div>
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
