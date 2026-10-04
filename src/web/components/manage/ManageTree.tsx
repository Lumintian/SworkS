/**
 * 数据管理用的树（headless-tree）：标签、学科/学段、属性选项共用。
 * - 选择：单击只选这一项、⌘/Ctrl+单击切换、⇧+单击连选（⌘⇧ 追加）、⌘/Ctrl+A 全选、Esc 取消；⇧+方向键扩展选择。
 * - 右键或每行的“⋯”按钮打开菜单，作用于整个选择（右键未选中的项时先只选它，与访达一致）。
 * - F2 或双击改名；Delete / Backspace 删除所选；可拖动所选项移动（由调用方决定能否改变上级、能否调整顺序）。
 * - 可选的过滤框：按完整路径匹配（与检索相同的规范化：全角半角、大小写、空白），只显示匹配项及其上级并全部展开；
 *   过滤时 ⌘/Ctrl+A 只选匹配项，不能拖动（看不到的同级项会让位置算错）。
 */
import { dragAndDropFeature, hotkeysCoreFeature, selectionFeature, syncDataLoaderFeature, type DragTarget, type ItemInstance, type Updater } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { ChevronRight, MoreHorizontal, Search, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { normText } from '@shared/query/normalize';
import {
  ContextContent,
  ContextItem,
  ContextMenu,
  ContextSeparator,
  ContextTrigger,
  DropdownContent,
  DropdownItem,
  DropdownMenu,
  DropdownSeparator,
  DropdownTrigger,
} from '../Menu';

export interface ManageNode {
  id: string;
  parentId: string | null;
  label: string;
  /** 名称后的补充说明（例如使用次数） */
  hint?: ReactNode;
  /** 弱化显示（例如不在候选中的值） */
  muted?: boolean;
}

export interface MenuAction {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** 在这一项前加分隔线 */
  separatorBefore?: boolean;
}

export interface ManageTreeDrag {
  /** 能否放到另一项之下（改变上级） */
  canReparent: boolean;
  /** 能否在同级之间调整顺序 */
  canReorder: boolean;
  /** index 为放下位置在“去掉被拖动项之后”的同级列表中的下标；放到某项上时为 undefined（放到最后） */
  onMove: (ids: string[], parentId: string | null, index: number | undefined) => void | Promise<void>;
}

const ROOT = '__manage_root__';
type RootNode = { id: typeof ROOT; parentId: null; label: string };

function isTextInput(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

/** 内容与上次相同时返回上次的数组（保持引用稳定）。 */
function useStableArray(next: string[]): string[] {
  const ref = useRef(next);
  const prev = ref.current;
  if (prev.length !== next.length || prev.some((x, i) => x !== next[i])) ref.current = next;
  return ref.current;
}

function RenameInput({ initial, label, onSubmit, onCancel }: { initial: string; label: string; onSubmit: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(initial);
  return (
    <input
      className="input min-w-0 flex-1 py-0.5"
      value={v}
      autoFocus
      aria-label={label}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setV(e.target.value)}
      onBlur={onCancel}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          if (v.trim() && v.trim() !== initial) onSubmit(v.trim());
          else onCancel();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    />
  );
}

export function ManageTree<N extends ManageNode>({
  label,
  nodes,
  selectedIds,
  onSelectedIdsChange,
  expandAll = false,
  drag,
  actions,
  onDelete,
  rename,
  renamingId: renamingIdProp,
  onRenamingIdChange,
  emptyText,
  filterPlaceholder,
}: {
  /** 树的无障碍名称，例如“标签树” */
  label: string;
  /** 平铺的节点（父节点在前，同级按显示顺序） */
  nodes: readonly N[];
  selectedIds: readonly string[];
  onSelectedIdsChange: (ids: string[]) => void;
  /** 默认全部展开（之后可以逐个折叠） */
  expandAll?: boolean;
  drag?: ManageTreeDrag | undefined;
  /** 作用于所选项的菜单；helpers.startRename 可在菜单项里开始改名 */
  actions: (selected: N[], helpers: { startRename: (id: string) => void }) => MenuAction[];
  /** Delete / Backspace */
  onDelete?: ((selected: N[]) => void) | undefined;
  rename?: { label: string; initial: (n: N) => string; submit: (n: N, value: string) => void } | undefined;
  /** 受控的改名状态（例如工具栏上的“改名”按钮）；不传则由组件自己管理 */
  renamingId?: string | null | undefined;
  onRenamingIdChange?: ((id: string | null) => void) | undefined;
  emptyText?: ReactNode;
  /** 提供时在树上方显示过滤框 */
  filterPlaceholder?: string | undefined;
}) {
  const [query, setQuery] = useState('');
  const q = normText(query);
  /** 过滤：匹配完整路径的项，以及为了显示它们而保留的上级 */
  const filter = useMemo(() => {
    if (!q) return null;
    const all = new Map(nodes.map((n) => [n.id, n]));
    const pathOf = (n: N) => {
      const segs = [n.label];
      for (let p = n.parentId ? all.get(n.parentId) : undefined; p; p = p.parentId ? all.get(p.parentId) : undefined) segs.unshift(p.label);
      return segs.join('/');
    };
    const matches = new Set(nodes.filter((n) => normText(pathOf(n)).includes(q)).map((n) => n.id));
    const keep = new Set<string>();
    for (const id of matches) for (let x: string | null | undefined = id; x && !keep.has(x); x = all.get(x)?.parentId) keep.add(x);
    return { matches, keep };
  }, [nodes, q]);
  const shown = useMemo(() => (filter ? nodes.filter((n) => filter.keep.has(n.id)) : nodes), [nodes, filter]);
  const byId = useMemo(() => new Map(shown.map((n) => [n.id, n])), [shown]);
  const childrenOf = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const n of shown) {
      const k = n.parentId ?? ROOT;
      m.set(k, [...(m.get(k) ?? []), n.id]);
    }
    return m;
  }, [shown]);
  const folders = useMemo(() => shown.filter((n) => childrenOf.has(n.id)).map((n) => n.id), [shown, childrenOf]);
  // 默认展开时记录“折叠了哪些”，新出现的上级自动展开；否则记录“展开了哪些”。过滤时另记一份（全部展开起步），清空过滤即恢复原来的展开状态
  const [toggled, setToggled] = useState<string[]>([]);
  const [filterCollapsed, setFilterCollapsed] = useState<string[]>([]);
  const allExpanded = Boolean(filter) || expandAll;
  const collapsedNow = filter ? filterCollapsed : toggled;
  // headless-tree 在渲染中比较 state 的引用，引用一变就同步 setState；内容相同时必须沿用同一个数组，否则会无限重渲染
  const expandedItems = useStableArray(allExpanded ? folders.filter((id) => !collapsedNow.includes(id)) : toggled);
  const liveSelected = useStableArray(selectedIds.filter((id) => byId.has(id)));
  // 新选中的项（例如刚新建的下级、合并的目标）藏在折叠的上级里时，展开它的上级；每项只展开一次，之后用户可以再折叠
  const revealed = useRef(new Set<string>());
  useEffect(() => {
    const hidden: string[] = [];
    for (const id of liveSelected) {
      if (revealed.current.has(id)) continue;
      revealed.current.add(id);
      for (let p = byId.get(id)?.parentId; p; p = byId.get(p)?.parentId) if (!expandedItems.includes(p)) hidden.push(p);
    }
    for (const id of revealed.current) if (!liveSelected.includes(id)) revealed.current.delete(id);
    if (hidden.length === 0) return;
    if (filter) setFilterCollapsed((xs) => xs.filter((x) => !hidden.includes(x)));
    else if (expandAll) setToggled((xs) => xs.filter((x) => !hidden.includes(x)));
    else setToggled((xs) => [...new Set([...xs, ...hidden])]);
  }, [liveSelected, byId, expandedItems, filter, expandAll]);
  const [renamingIdState, setRenamingIdState] = useState<string | null>(null);
  const renamingId = renamingIdProp !== undefined ? renamingIdProp : renamingIdState;
  const setRenamingId = (id: string | null) => {
    setRenamingIdState(id);
    onRenamingIdChange?.(id);
  };
  const anchor = useRef<string | null>(null);

  const setExpanded = (u: Updater<string[]>) => {
    const next = typeof u === 'function' ? u(expandedItems) : u;
    if (filter) setFilterCollapsed(folders.filter((id) => !next.includes(id)));
    else setToggled(expandAll ? folders.filter((id) => !next.includes(id)) : next);
  };
  const setSelected = (u: Updater<string[]>) => {
    const next = typeof u === 'function' ? u(liveSelected) : u;
    onSelectedIdsChange(next.filter((id) => id !== ROOT));
  };

  const tree = useTree<N | RootNode>({
    rootItemId: ROOT,
    state: { expandedItems, selectedItems: liveSelected },
    setExpandedItems: setExpanded,
    setSelectedItems: setSelected,
    getItemName: (item) => item.getItemData()?.label ?? '',
    isItemFolder: (item) => childrenOf.has(item.getId()),
    dataLoader: {
      getItem: (id) => (id === ROOT ? { id: ROOT, parentId: null, label } : (byId.get(id) ?? { id: ROOT, parentId: null, label: '' })),
      getChildren: (id) => childrenOf.get(id) ?? [],
    },
    canReorder: (drag?.canReorder ?? false) && !filter,
    canDrag: () => Boolean(drag) && !filter,
    canDrop: (items, target) => {
      if (!drag || filter) return false;
      const tid = target.item.getId();
      if (items.some((i) => i.getId() === tid)) return false;
      if ('childIndex' in target) return drag.canReorder && (tid === ROOT || drag.canReparent);
      return drag.canReparent || tid === ROOT;
    },
    onDrop: async (items: ItemInstance<N | RootNode>[], target: DragTarget<N | RootNode>) => {
      if (!drag) return;
      const ids = items.map((i) => i.getId());
      const tid = target.item.getId();
      const parentId = tid === ROOT ? null : tid;
      let index: number | undefined;
      if ('childIndex' in target) {
        const before = (childrenOf.get(tid) ?? []).slice(0, target.insertionIndex).filter((x) => !ids.includes(x));
        index = before.length;
      }
      await drag.onMove(ids, parentId, index);
    },
    indent: 18,
    features: [syncDataLoaderFeature, selectionFeature, hotkeysCoreFeature, dragAndDropFeature],
  });

  useEffect(() => {
    tree.rebuildTree();
  }, [tree, shown, childrenOf]);

  const visibleIds = () =>
    tree
      .getItems()
      .map((i) => i.getId())
      .filter((id) => id !== ROOT && (!filter || filter.matches.has(id)));

  const onRowClick = (item: ItemInstance<N | RootNode>, e: MouseEvent) => {
    const id = item.getId();
    if (e.shiftKey && anchor.current) {
      const order = visibleIds();
      const a = order.indexOf(anchor.current);
      const b = order.indexOf(id);
      if (a >= 0 && b >= 0) {
        const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
        setSelected(e.metaKey || e.ctrlKey ? [...new Set([...liveSelected, ...range])] : range);
        item.setFocused();
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) setSelected(liveSelected.includes(id) ? liveSelected.filter((x) => x !== id) : [...liveSelected, id]);
    else setSelected([id]);
    anchor.current = id;
    item.setFocused();
  };

  /** 右键或“⋯”：未选中的项先只选它。 */
  const ensureSelected = (id: string) => {
    if (!liveSelected.includes(id)) {
      setSelected([id]);
      anchor.current = id;
    }
  };

  const selectedNodes = liveSelected.map((id) => byId.get(id)).filter((n): n is N => Boolean(n));
  const targets = (): N[] => {
    if (selectedNodes.length) return selectedNodes;
    const f = tree.getFocusedItem();
    const n = f ? byId.get(f.getId()) : undefined;
    return n ? [n] : [];
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (renamingId || isTextInput(e.target)) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && onDelete) {
      const t = targets();
      if (t.length) {
        e.preventDefault();
        onDelete(t);
      }
    } else if (e.key === 'F2' && rename) {
      const t = targets();
      if (t.length === 1) {
        e.preventDefault();
        setRenamingId(t[0]!.id);
      }
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      e.stopPropagation();
      setSelected(visibleIds());
    } else if (e.key === 'Escape' && liveSelected.length) {
      e.preventDefault();
      setSelected([]);
    }
  };

  const menuItems = (kind: 'context' | 'dropdown') => {
    const Item = kind === 'context' ? ContextItem : DropdownItem;
    const Sep = kind === 'context' ? ContextSeparator : DropdownSeparator;
    return actions(selectedNodes, { startRename: (id) => rename && setRenamingId(id) }).map((a, i) => (
      <Fragment key={a.key}>
        {a.separatorBefore && i > 0 ? <Sep /> : null}
        <Item onSelect={a.onSelect} danger={a.danger ?? false} disabled={a.disabled ?? false}>
          {a.icon}
          {a.label}
        </Item>
      </Fragment>
    ));
  };

  return (
    <div onKeyDown={onKeyDown}>
      {filterPlaceholder && nodes.length > 0 ? (
        <div className="sticky top-0 z-10 -mx-2 -mt-2 mb-1 flex items-center gap-2 bg-surface px-2 pb-1.5 pt-2">
          <span className="relative min-w-0 flex-1">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
            <input
              className="input py-1 pl-8 pr-7"
              value={query}
              placeholder={filterPlaceholder}
              aria-label={`过滤${label}`}
              onChange={(e) => {
                setQuery(e.target.value);
                setFilterCollapsed([]);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery('');
                }
              }}
            />
            {query ? (
              <button type="button" className="absolute right-1.5 top-1/2 -translate-y-1/2 text-ink-faint hover:text-ink" aria-label="清空过滤" onClick={() => setQuery('')}>
                <X size={14} />
              </button>
            ) : null}
          </span>
          {filter ? <span className="flex-none text-xs text-ink-faint">{filter.matches.size ? `${filter.matches.size} 项` : '没有匹配项'}</span> : null}
        </div>
      ) : null}
      {nodes.length === 0 && emptyText ? <p className="px-2 py-4 text-center text-sm text-ink-faint">{emptyText}</p> : null}
      <div {...tree.getContainerProps(label)} aria-multiselectable="true" className="outline-none">
        {tree.getItems().map((item) => {
          const id = item.getId();
          const n = byId.get(id);
          if (!n) return null;
          const level = item.getItemMeta().level;
          const selected = liveSelected.includes(id);
          return (
            <ContextMenu key={id}>
              <ContextTrigger asChild>
                <div
                  {...item.getProps()}
                  className="tree-row group"
                  aria-selected={selected}
                  data-active={selected || undefined}
                  data-drop={item.isDragTarget() || undefined}
                  data-testid="manage-row"
                  style={{ paddingLeft: `${level * 18 + 2}px` }}
                  onClick={(e) => onRowClick(item, e)}
                  onDoubleClick={() => rename && setRenamingId(id)}
                  onContextMenu={() => {
                    ensureSelected(id);
                    item.setFocused();
                  }}
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
                  {renamingId === id && rename ? (
                    <RenameInput
                      initial={rename.initial(n)}
                      label={rename.label}
                      onCancel={() => setRenamingId(null)}
                      onSubmit={(v) => {
                        setRenamingId(null);
                        rename.submit(n, v);
                      }}
                    />
                  ) : (
                    <>
                      <span className={`truncate ${n.muted || (filter && !filter.matches.has(id)) ? 'text-ink-faint' : ''}`}>{n.label}</span>
                      {n.hint ? <span className="ml-2 truncate text-xs font-normal text-ink-faint">{n.hint}</span> : null}
                      <span className="flex-1" />
                      <DropdownMenu onOpenChange={(open) => open && ensureSelected(id)}>
                        <DropdownTrigger asChild>
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon h-6 w-6 flex-none opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
                            aria-label={`${n.label} 的操作`}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal size={14} />
                          </button>
                        </DropdownTrigger>
                        <DropdownContent align="end">{menuItems('dropdown')}</DropdownContent>
                      </DropdownMenu>
                    </>
                  )}
                </div>
              </ContextTrigger>
              <ContextContent>{menuItems('context')}</ContextContent>
            </ContextMenu>
          );
        })}
        <div style={tree.getDragLineStyle()} className="h-0.5 bg-sage-deep" />
      </div>
    </div>
  );
}
