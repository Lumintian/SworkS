/**
 * 导航面板（参照 Notebook Navigator 的导航区）：库、标签树、学科/学段，
 * 点击节点即筛选当前集合；⌘/Ctrl+点击把标签追加为“且”条件；把列表行拖到标签上即加标签。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Archive,
  BookOpen,
  ChevronRight,
  FilePlus2,
  Inbox,
  Info,
  Library,
  Plus,
  Search,
  SlidersHorizontal,
  Trash2,
  Users,
} from 'lucide-react';
import type { BatchAction, NavDTO, PropertyDefDTO } from '@shared/api';
import { EMPTY_FILTERS, NONE_VALUE, parseListFilters, TRUE_VALUE, type ListFilters } from '@shared/listFilters';
import { buildTagTree, tagKey, type TagTreeNode } from '@shared/tagPath';
import { errorMessage, loadSession } from '../lib/api';
import { runBatch } from '../lib/batch';
import { daysSince, newId } from '../lib/format';
import { MOD_LABEL } from '../lib/hotkeys';
import { collectionOfPath, listParams, listPathOf, useNav, useStudents, type Collection } from '../lib/queries';
import { Link, useRouter } from '../lib/router';
import { propertiesFor, useCatalog } from '../lib/useCatalog';
import { NavTree, type NavNode } from './NavTree';
import { useToast } from './ui';

function NavItem({ to, icon, children, match, count }: { to: string; icon: ReactNode; children: ReactNode; match: (p: string) => boolean; count?: ReactNode }) {
  const { path } = useRouter();
  return (
    <Link to={to} className="nav-item" aria-current={match(path) ? 'page' : undefined}>
      {icon}
      {children}
      {count}
    </Link>
  );
}

function useCollapsed(key: string): [boolean, () => void] {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem(key) === '1';
    } catch {
      return false;
    }
  });
  return [
    v,
    () =>
      setV((x) => {
        try {
          localStorage.setItem(key, x ? '0' : '1');
        } catch {
          // 只影响折叠状态的记忆
        }
        return !x;
      }),
  ];
}

function Section({ id, title, children, action }: { id: string; title: string; children: ReactNode; action?: ReactNode }) {
  const [collapsed, toggle] = useCollapsed(`sworks.nav.section.${id}`);
  return (
    <section className="space-y-0.5">
      <div className="flex items-center">
        <button type="button" className="nav-section-title" aria-expanded={!collapsed} onClick={toggle}>
          <ChevronRight size={12} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
          {title}
        </button>
        {action}
      </div>
      {collapsed ? null : children}
    </section>
  );
}

function tagNodes(nodes: TagTreeNode[], counts: Record<string, number>, activeKeys: Set<string>): NavNode[] {
  return nodes.map((n) => ({
    id: `tag:${n.key}`,
    label: n.name,
    title: n.path,
    count: counts[n.key] ?? 0,
    active: activeKeys.has(n.key),
    droppable: true,
    children: n.children.length ? tagNodes(n.children, counts, activeKeys) : undefined,
  }));
}

/** 属性的导航节点：选项树（计数含子树）、勾选属性的“是”，以及“未设置”。 */
function propertyNodes(def: PropertyDefDTO, nav: NavDTO | undefined, active: string[]): NavNode[] {
  const counts = nav?.properties.find((p) => p.propertyId === def.id);
  if (!counts) return [];
  const make = (parentId: string | null): NavNode[] =>
    def.options
      .filter((o) => o.parentId === parentId && (counts.counts[o.id] ?? 0) > 0)
      .map((o) => {
        const children = make(o.id);
        return {
          id: `prop:${def.id}:${o.id}`,
          label: o.label,
          title: o.path,
          count: counts.counts[o.id] ?? 0,
          active: active.includes(o.id),
          droppable: true,
          children: children.length ? children : undefined,
        };
      });
  const nodes: NavNode[] =
    def.type === 'checkbox'
      ? [{ id: `prop:${def.id}:${TRUE_VALUE}`, label: '是', count: counts.counts[TRUE_VALUE] ?? 0, active: active.includes(TRUE_VALUE), droppable: true }]
      : make(null);
  if (counts.none > 0 && nodes.length > 0) {
    nodes.push({ id: `prop:${def.id}:${NONE_VALUE}`, label: '未设置', count: counts.none, active: active.includes(NONE_VALUE), muted: true });
  }
  return nodes;
}

export function NavPane({ onOpenPalette }: { onOpenPalette: () => void }) {
  const { path, search, navigate } = useRouter();
  const toast = useToast();
  const collection: Collection = collectionOfPath(path);
  const listPath = listPathOf(path);
  const onListPage = path === listPath || (path === '/' && listPath === '/problems');
  const nav = useNav(collection);
  const students = useStudents();
  const catalog = useCatalog();
  const navDefs = propertiesFor(catalog, collection).filter((d) => d.showInNav && (d.type === 'select' || d.type === 'multiselect' || d.type === 'checkbox'));
  const [lastBackup, setLastBackup] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    loadSession(true).then((s) => setLastBackup(s.lastBackupAt), () => setLastBackup(undefined));
  }, [path]);
  const days = daysSince(lastBackup);

  // 只有在列表页时，当前筛选才算“生效”
  const filters: ListFilters = useMemo(() => {
    if (!onListPage) return EMPTY_FILTERS;
    return parseListFilters(new URLSearchParams(search));
  }, [onListPage, search]);

  const go = (f: ListFilters) => {
    const s = listParams({ ...f, status: undefined });
    navigate(`${listPath}${s ? `?${s}` : ''}`, onListPage ? { replace: true } : undefined);
  };

  const data = nav.data;
  const tagTree = useMemo(() => {
    if (!data) return [];
    const active = new Set(filters.tagPaths.map(tagKey));
    const nodes = tagNodes(buildTagTree(data.tags), data.tagTreeCounts, active);
    if (data.untagged > 0 || filters.untagged) {
      nodes.push({ id: 'tag:__untagged__', label: '无标签', count: data.untagged, active: filters.untagged, muted: true });
    }
    return nodes;
  }, [data, filters.tagPaths, filters.untagged]);

  const valueNodes = (kind: 'subject' | 'stage'): NavNode[] => {
    if (!data) return [];
    const current = filters[kind];
    const list = kind === 'subject' ? data.subjects : data.stages;
    const none = kind === 'subject' ? data.noSubject : data.noStage;
    const nodes: NavNode[] = list.map((v) => ({ id: `${kind}:${v.value}`, label: v.value, count: v.count, active: current === v.value }));
    if (none > 0 && list.length > 0) nodes.push({ id: `${kind}:${NONE_VALUE}`, label: '未设置', count: none, active: current === NONE_VALUE, muted: true });
    return nodes;
  };

  const onTag = (node: NavNode, additive: boolean) => {
    const key = node.id.slice(4);
    if (key === '__untagged__') {
      go({ ...filters, tagPaths: [], tagIds: [], untagged: !filters.untagged });
      return;
    }
    const pathLabel = node.title ?? node.label;
    const has = filters.tagPaths.some((p) => tagKey(p) === key);
    let tagPaths: string[];
    if (additive) tagPaths = has ? filters.tagPaths.filter((p) => tagKey(p) !== key) : [...filters.tagPaths, pathLabel];
    else tagPaths = has && filters.tagPaths.length === 1 ? [] : [pathLabel];
    go({ ...filters, tagPaths, tagIds: [], untagged: false });
  };

  const onValue = (kind: 'subject' | 'stage') => (node: NavNode) => {
    const value = node.id.slice(kind.length + 1);
    go({ ...filters, [kind]: filters[kind] === value ? '' : value });
  };

  const onProp = (def: PropertyDefDTO) => (node: NavNode, additive: boolean) => {
    const value = node.id.slice(`prop:${def.id}:`.length);
    const current = filters.props.find((p) => p.propertyId === def.id)?.values ?? [];
    let values: string[];
    if (additive) values = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    else values = current.length === 1 && current[0] === value ? [] : [value];
    const others = filters.props.filter((p) => p.propertyId !== def.id);
    go({ ...filters, props: values.length ? [...others, { propertyId: def.id, values }] : others });
  };

  const dropOnProp = (def: PropertyDefDTO) => async (node: NavNode, ids: string[]) => {
    const value = node.id.slice(`prop:${def.id}:`.length);
    if (value === NONE_VALUE) return;
    try {
      const action: BatchAction =
        def.type === 'multiselect'
          ? { op: 'addOptions', propertyId: def.id, optionIds: [value] }
          : def.type === 'checkbox'
            ? { op: 'setProperty', propertyId: def.id, value: { propertyId: def.id, checked: true } }
            : { op: 'setProperty', propertyId: def.id, value: { propertyId: def.id, optionIds: [value] } };
      const r = await runBatch(collection, ids, action);
      toast(r.changed.length ? `已给 ${r.changed.length} 项设置“${def.name}：${node.title ?? node.label}”` : '所选内容已是这个取值', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const dropOnTag = async (node: NavNode, ids: string[]) => {
    const key = node.id.slice(4);
    if (key === '__untagged__') return;
    const name = node.title ?? node.label;
    try {
      const r = await runBatch(collection, ids, { op: 'addTags', names: [name] });
      toast(r.changed.length ? `已给 ${r.changed.length} 项加上“${name}”` : `所选内容已有“${name}”`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const noun = collection === 'problems' ? '题目' : '资料';

  return (
    <aside className="flex flex-col gap-4 border-b border-line px-3 py-4 md:sticky md:top-0 md:h-screen md:overflow-y-auto md:border-b-0 md:border-r md:py-5" aria-label="导航">
      <Link to="/problems" className="flex items-baseline gap-2 px-2">
        <span className="font-serif text-2xl font-bold text-stone">SworkS</span>
        <span className="text-xs text-ink-faint">家教工作台</span>
      </Link>
      <div className="flex gap-2 md:flex-col">
        <button type="button" className="btn btn-primary flex-1 justify-start" onClick={() => navigate(`/problems/new?id=${newId()}`)} data-testid="new-problem">
          <Plus size={17} /> 收一道题
        </button>
        <button type="button" className="btn flex-1 justify-start" onClick={() => navigate(`/materials/new?id=${newId()}`)} data-testid="new-material">
          <FilePlus2 size={17} /> 收一份资料
        </button>
        <button type="button" className="btn btn-ghost flex-1 justify-start text-ink-faint" onClick={onOpenPalette} data-testid="open-palette">
          <Search size={16} /> 查找与跳转
          <span className="kbd ml-auto hidden md:inline-block">{MOD_LABEL} K</span>
        </button>
      </div>

      <nav aria-label="主导航" className="flex flex-wrap gap-1 md:flex-col">
        <NavItem
          to="/problems"
          icon={<BookOpen size={17} />}
          match={(p) => p === '/' || p.startsWith('/problems')}
          count={data ? <span className="tree-count">{data.library.problems}</span> : null}
        >
          题目
        </NavItem>
        <NavItem
          to="/materials"
          icon={<Library size={17} />}
          match={(p) => p.startsWith('/materials')}
          count={data ? <span className="tree-count">{data.library.materials}</span> : null}
        >
          资料
        </NavItem>
        <NavItem
          to="/inbox"
          icon={<Inbox size={17} />}
          match={(p) => p.startsWith('/inbox')}
          count={data?.library.inbox ? <span className="chip chip-warn ml-auto px-2 py-0 text-xs">{data.library.inbox}</span> : null}
        >
          收件箱
        </NavItem>
        <NavItem to="/students" icon={<Users size={17} />} match={(p) => p === '/students'} count={students.data ? <span className="tree-count">{students.data.length}</span> : null}>
          学生
        </NavItem>
      </nav>

      {students.data?.length ? (
        <div className="hidden md:block">
          <Section id="students" title="学生">
            <ul className="space-y-0.5" aria-label="学生列表">
              {students.data.map((st) => (
                <li key={st.id}>
                  <Link to={`/students/${st.id}`} className="tree-row pl-6" data-active={path === `/students/${st.id}` || undefined}>
                    <span className="min-w-0 truncate">{st.name}</span>
                    {st.stats.openMistakes ? (
                      <span className="tree-count text-terracotta" title="当前错题">
                        错 {st.stats.openMistakes}
                      </span>
                    ) : (
                      <span className="tree-count">{st.stats.problems}</span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      ) : null}

      <div className="hidden space-y-3 md:block">
        <Section id="tags" title={`${noun}标签`}>
          {tagTree.length ? (
            <NavTree label={`${noun}标签树`} nodes={tagTree} storageKey={`sworks.nav.tags.${collection}`} onSelect={onTag} onDropItems={(n, ids) => void dropOnTag(n, ids)} />
          ) : (
            <p className="px-3 text-xs text-ink-faint">{nav.isLoading ? '加载中…' : '还没有标签。标签可用 / 分层，例如“方法/换元”。'}</p>
          )}
        </Section>
        {navDefs.map((def) => {
          const nodes = propertyNodes(def, data, filters.props.find((p) => p.propertyId === def.id)?.values ?? []);
          return nodes.length ? (
            <Section key={def.id} id={`prop-${def.id}`} title={def.name}>
              <NavTree
                label={`${def.name}筛选树`}
                nodes={nodes}
                storageKey={`sworks.nav.prop.${def.id}`}
                onSelect={onProp(def)}
                onDropItems={(n, ids) => void dropOnProp(def)(n, ids)}
              />
            </Section>
          ) : null;
        })}
        {valueNodes('subject').length ? (
          <Section id="subjects" title="按学科">
            <NavTree label="学科筛选树" nodes={valueNodes('subject')} storageKey="sworks.nav.subjects" onSelect={onValue('subject')} />
          </Section>
        ) : null}
        {valueNodes('stage').length ? (
          <Section id="stages" title="按学段">
            <NavTree label="学段筛选树" nodes={valueNodes('stage')} storageKey="sworks.nav.stages" onSelect={onValue('stage')} />
          </Section>
        ) : null}
      </div>

      <nav aria-label="辅助入口" className="flex flex-wrap gap-1 border-t border-line pt-4 md:mt-auto md:flex-col">
        <NavItem to="/manage" icon={<SlidersHorizontal size={16} />} match={(p) => p.startsWith('/manage')}>
          数据管理
        </NavItem>
        <NavItem to="/trash" icon={<Trash2 size={16} />} match={(p) => p.startsWith('/trash')}>
          回收站
        </NavItem>
        <NavItem to="/backup" icon={<Archive size={16} />} match={(p) => p.startsWith('/backup')}>
          备份与导出
        </NavItem>
        <NavItem to="/about" icon={<Info size={16} />} match={(p) => p.startsWith('/about')}>
          数据目录与运行信息
        </NavItem>
      </nav>
      <div className="hidden px-2 text-xs leading-5 text-ink-faint md:block">
        {lastBackup === null ? (
          <span className="text-ochre">尚未做过完整备份</span>
        ) : days !== null ? (
          <span className={days >= 7 ? 'text-ochre' : ''}>最近备份：{days === 0 ? '今天' : `${days} 天前`}</span>
        ) : null}
      </div>
    </aside>
  );
}
