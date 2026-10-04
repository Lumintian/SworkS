/**
 * 数据管理 → 学科、学段：候选排序（拖动）、改名、合并、从所有对象上清除、移出候选。
 * 会改动题目或资料的操作都先确认影响范围（含回收站中的对象），完成后可以撤销。
 */
import { Eye, Merge, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { DictEntryDTO, DictKind, UsageDTO } from '@shared/api';
import { errorMessage, sendJSON } from '../../lib/api';
import { CATALOG_ONLY, invalidateWrites } from '../../lib/queryClient';
import { useRouter } from '../../lib/router';
import { Dialog, useConfirm, useToast } from '../ui';
import { DuplicateHint, findDuplicates } from './DuplicateHint';
import { ManageHelp, treeTips } from './ManageHelp';
import { ManageTree, type ManageNode } from './ManageTree';
import { sumUsage, UNDO_HINT, usage, used } from './usage';
import { useUndoToast } from './useUndoToast';

export const DICT_LABEL: Record<DictKind, string> = { subject: '学科', stage: '学段' };

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

export function DictPanel({ kind, entries }: { kind: DictKind; entries: DictEntryDTO[] }) {
  const toast = useToast();
  const undoToast = useUndoToast();
  const confirm = useConfirm();
  const { navigate } = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [merging, setMerging] = useState<DictEntryDTO[] | null>(null);
  const [adding, setAdding] = useState('');
  const label = DICT_LABEL[kind];
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

  /** 只动候选（添加、排序、移出）：不改题目内容 */
  const call = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      invalidateWrites(CATALOG_ONLY);
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
      <div className="flex items-start gap-2">
        <p className="flex-1 text-sm text-ink-soft">编辑页里{label}候选的顺序与这里一致。改名、合并会同时改写题目和资料上的取值。</p>
        <ManageHelp
          title={`${label}列表`}
          tips={[
            ...treeTips({ drag: '拖动调整候选顺序；把灰色的值（题目上用过、但不在候选里）拖进来即加入候选', del: 'Delete：没人用的值移出候选，有人用的从题目和资料上清除' }),
            '改名为已有的值，两者合并为一个',
          ]}
        />
      </div>
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
