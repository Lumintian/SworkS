/**
 * 导航面板里的树（标签、学科/学段、以后的属性选项）：基于 headless-tree，
 * 提供键盘导航（方向键展开/收起、Home/End）、展开状态持久化，以及把列表行拖到节点上。
 * 点击节点 = 筛选（不切换展开）；左侧箭头负责展开/收起。
 */
import { hotkeysCoreFeature, syncDataLoaderFeature } from '@headless-tree/core';
import { useTree } from '@headless-tree/react';
import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import { LIST_DRAG_TYPE, readDraggedIds } from '../lib/dragItems';

export interface NavNode {
  id: string;
  label: string;
  count?: number | undefined;
  icon?: ReactNode;
  children?: NavNode[] | undefined;
  /** 是否为当前生效的筛选条件 */
  active?: boolean | undefined;
  /** 显示在鼠标悬停提示中的完整名称 */
  title?: string | undefined;
  /** 可以把列表行拖到这个节点上 */
  droppable?: boolean | undefined;
  /** 斜体显示（例如“无标签”“未设置”这类虚拟节点） */
  muted?: boolean | undefined;
}

const ROOT = '__root__';

function loadExpanded(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function NavTree({
  label,
  nodes,
  storageKey,
  onSelect,
  onDropItems,
  onContextMenu,
}: {
  label: string;
  nodes: NavNode[];
  storageKey: string;
  onSelect: (node: NavNode, additive: boolean) => void;
  onDropItems?: (node: NavNode, ids: string[]) => void;
  onContextMenu?: (node: NavNode, e: MouseEvent) => void;
}) {
  const byId = useMemo(() => {
    const m = new Map<string, NavNode>();
    const walk = (ns: NavNode[]) => {
      for (const n of ns) {
        m.set(n.id, n);
        if (n.children) walk(n.children);
      }
    };
    walk(nodes);
    m.set(ROOT, { id: ROOT, label, children: nodes });
    return m;
  }, [nodes, label]);
  const shape = useMemo(() => [...byId.keys()].join('|'), [byId]);

  const [expandedItems, setExpanded] = useState<string[]>(() => loadExpanded(storageKey));
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const tree = useTree<NavNode>({
    rootItemId: ROOT,
    state: { expandedItems },
    setExpandedItems: (updater) => {
      setExpanded((cur) => {
        const next = typeof updater === 'function' ? updater(cur) : updater;
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {
          // 浏览器存储不可用时只影响展开状态的记忆
        }
        return next;
      });
    },
    getItemName: (item) => item.getItemData()?.label ?? '',
    isItemFolder: (item) => Boolean(item.getItemData()?.children?.length),
    dataLoader: {
      getItem: (id) => byId.get(id) ?? { id, label: '' },
      getChildren: (id) => (byId.get(id)?.children ?? []).map((c) => c.id),
    },
    hotkeys: {
      customActivate: {
        hotkey: 'Enter',
        handler: (e, t) => {
          const item = t.getFocusedItem();
          const node = item?.getItemData();
          if (node) onSelect(node, e.metaKey || e.ctrlKey);
        },
      },
    },
    indent: 14,
    features: [syncDataLoaderFeature, hotkeysCoreFeature],
  });

  // 数据变化（计数、增删节点）后重建扁平列表
  useEffect(() => {
    tree.rebuildTree();
  }, [tree, shape, byId]);

  const drop = (node: NavNode) =>
    onDropItems && node.droppable
      ? {
          onDragOver: (e: DragEvent) => {
            if (!e.dataTransfer.types.includes(LIST_DRAG_TYPE)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            setDropTarget(node.id);
          },
          onDragLeave: () => setDropTarget((d) => (d === node.id ? null : d)),
          onDrop: (e: DragEvent) => {
            setDropTarget(null);
            const ids = readDraggedIds(e.dataTransfer);
            if (ids.length === 0) return;
            e.preventDefault();
            onDropItems(node, ids);
          },
        }
      : {};

  return (
    <div {...tree.getContainerProps(label)} className="flex flex-col outline-none">
      {tree.getItems().map((item) => {
        const node = item.getItemData();
        if (!node) return null;
        const level = item.getItemMeta().level;
        const folder = item.isFolder();
        const props = item.getProps();
        return (
          <div
            {...props}
            key={item.getId()}
            className="tree-row"
            data-active={node.active || undefined}
            data-drop={dropTarget === node.id || undefined}
            aria-selected={node.active ? 'true' : 'false'}
            title={node.title ?? node.label}
            style={{ paddingLeft: `${level * 14 + 2}px` }}
            onClick={(e) => {
              item.setFocused();
              onSelect(node, e.metaKey || e.ctrlKey);
            }}
            onContextMenu={onContextMenu ? (e) => onContextMenu(node, e) : undefined}
            {...drop(node)}
          >
            <span
              className={`flex h-5 w-5 flex-none items-center justify-center rounded text-ink-faint hover:text-stone ${folder ? '' : 'invisible'}`}
              aria-hidden="true"
              onClick={(e) => {
                e.stopPropagation();
                if (item.isExpanded()) item.collapse();
                else item.expand();
              }}
            >
              <ChevronRight size={13} className={`transition-transform ${item.isExpanded() ? 'rotate-90' : ''}`} />
            </span>
            {node.icon ? <span className="flex-none text-ink-faint">{node.icon}</span> : null}
            <span className={`min-w-0 truncate ${node.muted ? 'italic' : ''}`}>{node.label}</span>
            {node.count !== undefined ? <span className="tree-count">{node.count}</span> : null}
          </div>
        );
      })}
    </div>
  );
}
