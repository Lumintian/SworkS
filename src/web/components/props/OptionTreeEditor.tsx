/**
 * 选项树编辑（headless-tree）：拖动排序与改变上级、F2 或双击改名、方向键导航；
 * 工具栏新建同级/下级、删除（含子树）、合并到其他选项、导入大纲。
 */
import { dragAndDropFeature, hotkeysCoreFeature, renamingFeature, syncDataLoaderFeature, type DragTarget, type ItemInstance } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { ChevronRight, FileInput, GitMerge, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PropertyDefDTO, PropertyOptionDTO } from '@shared/api';
import { errorMessage, sendJSON } from '../../lib/api';
import { newId } from '../../lib/format';
import { invalidateWrites } from '../../lib/queryClient';
import { Popover, PopoverContent, PopoverTrigger } from '../Menu';
import { Dialog, useConfirm, useToast } from '../ui';
import { OptionPicker } from './OptionPicker';

const ROOT = '__root__';
type Node = PropertyOptionDTO | { id: typeof ROOT; label: string };

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

export function OptionTreeEditor({ def }: { def: PropertyDefDTO }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [selected, setSelected] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [expandedItems, setExpanded] = useState<string[]>([]);
  const byId = useMemo(() => new Map(def.options.map((o) => [o.id, o])), [def.options]);
  const childrenOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const o of def.options) {
      const k = o.parentId ?? ROOT;
      m.set(k, [...(m.get(k) ?? []), o.id]);
    }
    return m;
  }, [def.options]);
  const current = selected ? byId.get(selected) : undefined;

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

  const tree = useTree<Node>({
    rootItemId: ROOT,
    state: { expandedItems },
    setExpandedItems: setExpanded,
    getItemName: (item) => item.getItemData()?.label ?? '',
    isItemFolder: (item) => (childrenOf.get(item.getId())?.length ?? 0) > 0,
    dataLoader: {
      getItem: (id) => (id === ROOT ? { id: ROOT, label: def.name } : (byId.get(id) ?? { id: ROOT, label: '' })),
      getChildren: (id) => childrenOf.get(id) ?? [],
    },
    canReorder: true,
    canDrop: (_items, target) => def.nested || target.item.getId() === ROOT,
    onDrop: async (items: ItemInstance<Node>[], target: DragTarget<Node>) => {
      const moved = items[0];
      if (!moved) return;
      const id = moved.getId();
      const parentId = target.item.getId() === ROOT ? null : target.item.getId();
      let index: number | undefined;
      if ('childIndex' in target) {
        const old = childrenOf.get(target.item.getId()) ?? [];
        const inserted = [...old.slice(0, target.insertionIndex), `__moved__`, ...old.slice(target.insertionIndex)].filter((x) => x !== id);
        index = inserted.indexOf('__moved__');
      }
      await call(() => sendJSON('POST', `/api/property-options/${id}/move`, { parentId, index }));
    },
    onRename: (item, value) => {
      const v = value.trim();
      if (!v || v === item.getItemName()) return;
      void call(() => sendJSON('PUT', `/api/property-options/${item.getId()}`, { label: v }), '已改名');
    },
    onPrimaryAction: (item) => setSelected(item.getId()),
    indent: 18,
    features: [syncDataLoaderFeature, hotkeysCoreFeature, dragAndDropFeature, renamingFeature],
  });

  useEffect(() => {
    tree.rebuildTree();
  }, [tree, def.options, childrenOf]);

  const [adding, setAdding] = useState<{ parentId: string | null; label: string } | null>(null);
  const add = (parentId: string | null) => setAdding({ parentId, label: '' });
  const submitAdd = async () => {
    if (!adding?.label.trim()) return;
    const id = newId();
    const { parentId, label } = adding;
    if (await call(() => sendJSON('POST', `/api/properties/${def.id}/options`, { id, label: label.trim(), parentId }))) {
      if (parentId) setExpanded((e) => (e.includes(parentId) ? e : [...e, parentId]));
      setSelected(id);
      setAdding({ parentId, label: '' });
    }
  };

  const remove = async (o: PropertyOptionDTO) => {
    const kids = def.options.filter((x) => x.path.startsWith(`${o.path}/`)).length;
    const ok = await confirm({
      title: `删除“${o.path}”`,
      message: `${kids ? `连同 ${kids} 个下级选项一起删除，` : ''}并从使用它的题目与资料上移除这个${def.name}。题目和资料本身不受影响。`,
      confirmLabel: '删除',
      danger: true,
    });
    if (!ok) return;
    const r = await sendJSON<{ deleted: number; affectedItems: number }>('POST', `/api/property-options/${o.id}/delete`).catch((err: unknown) => {
      toast(errorMessage(err), 'error');
      return null;
    });
    if (r) {
      invalidateWrites();
      toast(`已删除 ${r.deleted} 个选项，影响 ${r.affectedItems} 项`, 'success');
      setSelected(null);
    }
  };

  const merge = async (o: PropertyOptionDTO, intoId: string) => {
    const into = byId.get(intoId);
    if (!into || into.id === o.id) return;
    setMergeOpen(false);
    const ok = await confirm({
      title: `把“${o.path}”合并到“${into.path}”`,
      message: '使用前者的题目与资料改为使用后者，前者的下级移到后者下面（同名的继续合并），然后删除前者。',
      confirmLabel: '合并',
    });
    if (!ok) return;
    if (await call(() => sendJSON('POST', `/api/property-options/${o.id}/merge`, { intoId }), '已合并')) setSelected(into.id);
  };

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
        <button
          type="button"
          className="btn btn-sm"
          disabled={!current}
          onClick={() => {
            if (!current) return;
            tree.getItemInstance(current.id).startRenaming();
          }}
        >
          <Pencil size={14} /> 改名
        </button>
        <Popover open={mergeOpen} onOpenChange={setMergeOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="btn btn-sm" disabled={!current}>
              <GitMerge size={14} /> 合并到…
            </button>
          </PopoverTrigger>
          <PopoverContent>
            {current ? <OptionPicker def={def} selected={[current.id]} allowCreate={false} placeholder="合并到哪个选项…" onPick={(id) => void merge(current, id)} /> : null}
          </PopoverContent>
        </Popover>
        <button type="button" className="btn btn-ghost btn-sm hover:!text-terracotta" disabled={!current} onClick={() => current && void remove(current)}>
          <Trash2 size={14} /> 删除
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
      <p className="text-xs text-ink-faint">拖动可调整顺序{def.nested ? '或放到别的选项下' : ''}；选中后按 F2 或双击改名。改名、移动不会改变题目的修改时间。</p>
      <div className="card-flat max-h-[60vh] overflow-y-auto px-2 py-2">
        {def.options.length === 0 ? <p className="px-2 py-4 text-center text-sm text-ink-faint">还没有选项。可以逐个新建，或粘贴一份大纲导入。</p> : null}
        <div {...tree.getContainerProps(`${def.name}选项树`)} className="outline-none">
          {tree.getItems().map((item) => {
            const data = item.getItemData();
            if (!data || item.getId() === ROOT) return null;
            const level = item.getItemMeta().level;
            return (
              <div
                {...item.getProps()}
                key={item.getId()}
                className="tree-row"
                data-active={selected === item.getId() || undefined}
                data-drop={item.isDragTarget() || undefined}
                style={{ paddingLeft: `${level * 18 + 2}px` }}
                onClick={() => {
                  item.setFocused();
                  setSelected(item.getId());
                }}
                onDoubleClick={() => item.startRenaming()}
              >
                <span
                  className={`flex h-5 w-5 flex-none items-center justify-center text-ink-faint ${item.isFolder() ? '' : 'invisible'}`}
                  aria-hidden="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (item.isExpanded()) item.collapse();
                    else item.expand();
                  }}
                >
                  <ChevronRight size={13} className={`transition-transform ${item.isExpanded() ? 'rotate-90' : ''}`} />
                </span>
                {item.isRenaming() ? (
                  <input {...item.getRenameInputProps()} className="input py-0.5" aria-label="选项新名称" onClick={(e) => e.stopPropagation()} />
                ) : (
                  <span className="truncate">{data.label}</span>
                )}
              </div>
            );
          })}
          <div style={tree.getDragLineStyle()} className="h-0.5 bg-sage-deep" />
        </div>
      </div>
      <OutlineImportDialog def={def} open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}
