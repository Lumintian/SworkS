/**
 * 选项树编辑（基于 ManageTree / headless-tree）：多选、右键菜单、拖动排序与改变上级、F2 或双击改名、Delete 删除；
 * 工具栏新建同级/下级、删除（含子树）、合并到其他选项、导入大纲。
 */
import { ArrowUpToLine, Eye, FileInput, GitMerge, Pencil, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { PropertyDefDTO, PropertyOptionDTO } from '@shared/api';
import { errorMessage, sendJSON } from '../../lib/api';
import { newId } from '../../lib/format';
import { invalidateWrites } from '../../lib/queryClient';
import { useRouter } from '../../lib/router';
import { ManageTree, type ManageNode } from '../manage/ManageTree';
import { useUndoToast } from '../manage/useUndoToast';
import { Popover, PopoverContent, PopoverTrigger } from '../Menu';
import { Dialog, useConfirm, useToast } from '../ui';
import { OptionPicker } from './OptionPicker';

function OutlineImportDialog({ def, open, onClose }: { def: PropertyDefDTO; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const preview = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(0, 12);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={`导入${def.name}大纲`}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!text.trim()}
            onClick={async () => {
              try {
                const r = await sendJSON<{ created: number; existing: number }>('POST', `/api/properties/${def.id}/import`, { outline: text });
                invalidateWrites();
                toast(`已新建 ${r.created} 个选项，${r.existing} 个已存在`, 'success');
                setText('');
                onClose();
              } catch (err) {
                toast(errorMessage(err), 'error');
              }
            }}
          >
            导入
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-ink-soft">
          每行一个{def.nested ? '，用缩进、Markdown 列表（- / 1.）或 # 标题表示层级' : '（此属性不分层，层级会被展平）'}。已存在的同名选项会直接沿用，不会重复。
        </p>
        <textarea
          className="textarea min-h-[14rem]"
          value={text}
          aria-label="大纲内容"
          placeholder={'# 函数\n- 函数的概念\n- 单调性\n  - 单调区间\n# 数列\n- 等差数列'}
          onChange={(e) => setText(e.target.value)}
        />
        {preview.length ? <p className="text-xs text-ink-faint">共 {text.split(/\r?\n/).filter((l) => l.trim()).length} 行</p> : null}
      </div>
    </Dialog>
  );
}

interface OptionNode extends ManageNode {
  option: PropertyOptionDTO;
}

export function OptionTreeEditor({ def }: { def: PropertyDefDTO }) {
  const toast = useToast();
  const undoToast = useUndoToast();
  const confirm = useConfirm();
  const { navigate } = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeDialog, setMergeDialog] = useState<PropertyOptionDTO[] | null>(null);
  const byId = useMemo(() => new Map(def.options.map((o) => [o.id, o])), [def.options]);
  const nodes: OptionNode[] = useMemo(() => def.options.map((o) => ({ id: o.id, parentId: o.parentId, label: o.label, option: o })), [def.options]);
  const selectedOptions = selected.map((id) => byId.get(id)).filter((o): o is PropertyOptionDTO => Boolean(o));
  const current = selectedOptions.length === 1 ? selectedOptions[0] : undefined;

  const call = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      invalidateWrites();
      if (ok) toast(ok, 'success');
      return true;
    } catch (err) {
      toast(errorMessage(err), 'error');
      return false;
    }
  };

  const [adding, setAdding] = useState<{ parentId: string | null; label: string } | null>(null);
  const add = (parentId: string | null) => setAdding({ parentId, label: '' });
  const submitAdd = async () => {
    if (!adding?.label.trim()) return;
    const id = newId();
    const { parentId, label } = adding;
    if (await call(() => sendJSON('POST', `/api/properties/${def.id}/options`, { id, label: label.trim(), parentId }))) {
      setSelected([id]);
      setAdding({ parentId, label: '' });
    }
  };

  /** 只保留最上层：上级也被选中时随上级处理。 */
  const topmost = (xs: PropertyOptionDTO[]) => xs.filter((x) => !xs.some((y) => y !== x && x.path.startsWith(`${y.path}/`)));

  const remove = async (sel: PropertyOptionDTO[]) => {
    const xs = topmost(sel);
    if (xs.length === 0) return;
    const kids = def.options.filter((o) => xs.some((x) => o.path.startsWith(`${x.path}/`))).length;
    const ok = await confirm({
      title: xs.length === 1 ? `删除“${xs[0]!.path}”` : `删除 ${xs.length} 个选项`,
      message: `${xs.length > 1 ? `${xs.map((x) => `“${x.path}”`).slice(0, 5).join('、')}${xs.length > 5 ? ' 等' : ''}，` : ''}${kids ? `连同 ${kids} 个下级选项一起删除，` : ''}并从使用它们的题目与资料上移除这个${def.name}。题目和资料本身不受影响。`,
      confirmLabel: xs.length === 1 ? '删除' : `删除 ${xs.length} 个选项`,
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await sendJSON<{ deleted: number; affectedItems: number; undoId?: string }>('POST', '/api/property-options/delete-many', { ids: xs.map((x) => x.id) });
      invalidateWrites();
      undoToast(`已删除 ${r.deleted} 个选项，影响 ${r.affectedItems} 项`, r.undoId);
      setSelected([]);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const merge = async (sel: PropertyOptionDTO[], intoId: string) => {
    const into = byId.get(intoId);
    const xs = topmost(sel).filter((x) => x.id !== intoId);
    setMergeOpen(false);
    setMergeDialog(null);
    if (!into || xs.length === 0) return;
    const ok = await confirm({
      title: xs.length === 1 ? `把“${xs[0]!.path}”合并到“${into.path}”` : `把 ${xs.length} 个选项合并到“${into.path}”`,
      message: '使用前者的题目与资料改为使用后者，前者的下级移到后者下面（同名的继续合并），然后删除前者。',
      confirmLabel: '合并',
    });
    if (!ok) return;
    try {
      const r = await sendJSON<{ affectedItems: number; undoId?: string }>('POST', '/api/property-options/merge-many', { ids: xs.map((x) => x.id), intoId });
      invalidateWrites();
      undoToast(`已合并${r.affectedItems ? `，影响 ${r.affectedItems} 项` : ''}`, r.undoId);
      setSelected([into.id]);
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const move = (ids: string[], parentId: string | null, index: number | undefined) =>
    void call(() => sendJSON('POST', '/api/property-options/move-many', { ids, parentId, index }));

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-sm" onClick={() => add(null)}>
          <Plus size={14} /> 新建{def.nested ? '顶级' : ''}选项
        </button>
        {def.nested ? (
          <button type="button" className="btn btn-sm" disabled={!current} onClick={() => current && add(current.id)}>
            <Plus size={14} /> 新建下级
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" disabled={!current} onClick={() => current && setRenamingId(current.id)}>
          <Pencil size={14} /> 改名
        </button>
        <Popover open={mergeOpen} onOpenChange={setMergeOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="btn btn-sm" disabled={selectedOptions.length === 0}>
              <GitMerge size={14} /> 合并到…
            </button>
          </PopoverTrigger>
          <PopoverContent>
            {selectedOptions.length ? (
              <OptionPicker def={def} selected={selected} allowCreate={false} placeholder="合并到哪个选项…" onPick={(id) => void merge(selectedOptions, id)} />
            ) : null}
          </PopoverContent>
        </Popover>
        <button type="button" className="btn btn-ghost btn-sm hover:!text-terracotta" disabled={selectedOptions.length === 0} onClick={() => void remove(selectedOptions)}>
          <Trash2 size={14} /> 删除{selectedOptions.length > 1 ? ` ${selectedOptions.length} 项` : ''}
        </button>
        <button type="button" className="btn btn-sage btn-sm ml-auto" onClick={() => setImporting(true)}>
          <FileInput size={14} /> 导入大纲
        </button>
      </div>
      {adding ? (
        <form
          className="flex flex-wrap items-center gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void submitAdd();
          }}
        >
          <span className="text-ink-soft">{adding.parentId ? `在“${byId.get(adding.parentId)?.path}”下新建：` : '新建顶级选项：'}</span>
          <input
            className="input max-w-xs py-1"
            value={adding.label}
            autoFocus
            maxLength={60}
            aria-label="新选项名称"
            onChange={(e) => setAdding({ ...adding, label: e.target.value })}
            onKeyDown={(e) => e.key === 'Escape' && setAdding(null)}
          />
          <button type="submit" className="btn btn-sage btn-sm" disabled={!adding.label.trim()}>
            添加
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(null)}>
            完成
          </button>
        </form>
      ) : null}
      <p className="text-xs text-ink-faint">
        单击选择，⌘/Ctrl 或 ⇧ 多选，右键或“⋯”打开菜单；拖动可调整顺序{def.nested ? '或放到别的选项下' : ''}；F2 或双击改名，Delete 删除所选。改名、移动不会改变题目的修改时间。
      </p>
      <div className="card-flat max-h-[60vh] overflow-y-auto px-2 py-2">
        <ManageTree<OptionNode>
          label={`${def.name}选项树`}
          nodes={nodes}
          selectedIds={selected}
          onSelectedIdsChange={setSelected}
          emptyText="还没有选项。可以逐个新建，或粘贴一份大纲导入。"
          drag={{ canReparent: def.nested, canReorder: true, onMove: move }}
          renamingId={renamingId}
          onRenamingIdChange={setRenamingId}
          rename={{
            label: '选项新名称',
            initial: (n) => n.option.label,
            submit: (n, v) => void call(() => sendJSON('PUT', `/api/property-options/${n.id}`, { label: v }), '已改名'),
          }}
          onDelete={(sel) => void remove(sel.map((n) => n.option))}
          actions={(sel, { startRename }) => {
            const xs = sel.map((n) => n.option);
            const one = xs.length === 1 ? xs[0] : undefined;
            return [
              {
                key: 'view',
                label: '在题目列表中查看',
                icon: <Eye size={13} />,
                disabled: !one,
                onSelect: () => one && navigate(`/problems?${new URLSearchParams({ prop: `${def.id}:${one.id}` }).toString()}`),
              },
              ...(def.nested ? [{ key: 'child', label: '新建下级', icon: <Plus size={13} />, disabled: !one, onSelect: () => one && add(one.id) }] : []),
              { key: 'rename', label: '改名', icon: <Pencil size={13} />, disabled: !one, onSelect: () => one && startRename(one.id) },
              ...(def.nested
                ? [{ key: 'top', label: '移到顶级', icon: <ArrowUpToLine size={13} />, disabled: !xs.some((x) => x.parentId !== null), onSelect: () => move(topmost(xs).map((x) => x.id), null, undefined) }]
                : []),
              { key: 'merge', label: '合并到…', icon: <GitMerge size={13} />, disabled: xs.length === 0, onSelect: () => setMergeDialog(xs) },
              {
                key: 'delete',
                label: xs.length > 1 ? `删除 ${topmost(xs).length} 项` : '删除',
                icon: <Trash2 size={13} />,
                danger: true,
                separatorBefore: true,
                disabled: xs.length === 0,
                onSelect: () => void remove(xs),
              },
            ];
          }}
        />
      </div>
      <Dialog open={mergeDialog !== null} onClose={() => setMergeDialog(null)} title={`把 ${mergeDialog?.length ?? 0} 个选项合并到…`}>
        <OptionPicker def={def} selected={mergeDialog?.map((x) => x.id) ?? []} allowCreate={false} placeholder="合并到哪个选项…" onPick={(id) => void merge(mergeDialog ?? [], id)} />
      </Dialog>
      <OutlineImportDialog def={def} open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}
