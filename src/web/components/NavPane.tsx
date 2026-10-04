/**
 * 导航面板（参照 Notebook Navigator 的导航区）：库、常用检索、标签树、属性、学科/学段。
 * 点击节点就是改写搜索框里的查询（GitHub 式，所有条件只在一处）：单击替换同一字段的条件，
 * ⌘/Ctrl+点击追加（标签为“且”，属性与学科学段在同一条件里取“或”）；高亮由查询推出。
 * 把列表行拖到标签或属性节点上即批量设置。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Archive,
  BookOpen,
  ChevronRight,
  EyeOff,
  FilePlus2,
  Inbox,
  Info,
  Library,
  NotebookText,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Users,
} from 'lucide-react';
import type { BatchAction, NavDTO, PropertyDefDTO } from '@shared/api';
import { EMPTY_FILTERS, NONE_VALUE, parseListFilters, TRUE_VALUE, type ListFilters } from '@shared/listFilters';
import { appendCondition, fieldText, navSelection, removeRows, rowsOf, setFieldCondition, type Q } from '@shared/query';
import { buildTagTree, tagKey, type TagTreeNode } from '@shared/tagPath';
import { errorMessage, loadSession, sendJSON } from '../lib/api';
import { runBatch } from '../lib/batch';
import { daysSince, newId } from '../lib/format';
import { MOD_LABEL } from '../lib/hotkeys';
import { collectionOfPath, listParams, listPathOf, useLessons, useNav, useStudents, type Collection } from '../lib/queries';
import { Link, useRouter } from '../lib/router';
import { propCondition, tagCondition, useQueryContext } from '../lib/queryText';
import { propertiesFor } from '../lib/useCatalog';
import { CATALOG_ONLY, invalidateWrites } from '../lib/queryClient';
import { ContextContent, ContextItem, ContextMenu, ContextTrigger } from './Menu';
import { NavTree, type NavNode } from './NavTree';
import { SavedSearchesNav } from './search/SavedSearchesNav';
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

function Section({ id, title, children, action, menu }: { id: string; title: string; children: ReactNode; action?: ReactNode; menu?: ReactNode }) {
  const [collapsed, toggle] = useCollapsed(`sworks.nav.section.${id}`);
  const heading = (
    <div className="flex items-center">
      <button type="button" className="nav-section-title" aria-expanded={!collapsed} onClick={toggle}>
        <ChevronRight size={12} className={`transition-transform ${collapsed ? '' : 'rotate-90'}`} />
        {title}
      </button>
      {action}
    </div>
  );
  return (
    <section className="space-y-0.5">
      {menu ? (
        <ContextMenu>
          <ContextTrigger asChild>{heading}</ContextTrigger>
          <ContextContent>{menu}</ContextContent>
        </ContextMenu>
      ) : (
        heading
      )}
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
  const lessons = useLessons();
  const qctx = useQueryContext();
  const { catalog } = qctx;
  const scope = collection === 'problems' ? 'problem' : 'material';
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

  const q = filters.q;
  const rows = useMemo(() => (qctx.ready && q ? rowsOf(q, qctx.qc, scope) : []), [q, qctx.ready, qctx.qc, scope]);
  const sel = useMemo(() => navSelection(rows), [rows]);

  /** 写入新的查询文本（保留排序与学生上下文），不在列表页时跳到列表页 */
  const go = (nextQ: string, sort = filters.sort) => {
    const s = listParams({ ...(onListPage ? filters : EMPTY_FILTERS), q: nextQ.trim(), sort, status: undefined });
    navigate(`${listPath}${s ? `?${s}` : ''}`, onListPage ? { replace: true } : undefined);
  };
  /** 同一字段：单击替换（再点一次已选中的唯一值则取消），⌘ 在同一条件里增减取值 */
  const toggleField = (key: { reserved?: string; propertyId?: string }, current: readonly string[], value: string, additive: boolean, build: (values: string[]) => string) => {
    const has = current.includes(value);
    let values: string[];
    if (additive) values = has ? current.filter((v) => v !== value) : [...current, value];
    else values = has && current.length === 1 ? [] : [value];
    go(setFieldCondition(q, qctx.qc, scope, key, values.length ? build(values) : null));
  };

  const data = nav.data;
  const tagTree = useMemo(() => {
    if (!data) return [];
    const active = new Set(sel.tagPaths.map(tagKey));
    const nodes = tagNodes(buildTagTree(data.tags), data.tagTreeCounts, active);
    if (data.untagged > 0 || sel.untagged) {
      nodes.push({ id: 'tag:__untagged__', label: '无标签', count: data.untagged, active: sel.untagged, muted: true });
    }
    return nodes;
  }, [data, sel]);

  const valueNodes = (kind: 'subject' | 'stage'): NavNode[] => {
    if (!data) return [];
    const current = sel[kind];
    const list = kind === 'subject' ? data.subjects : data.stages;
    const none = kind === 'subject' ? data.noSubject : data.noStage;
    const nodes: NavNode[] = list.map((v) => ({ id: `${kind}:${v.value}`, label: v.value, count: v.count, active: current.includes(v.value) }));
    if (none > 0 && list.length > 0) nodes.push({ id: `${kind}:${NONE_VALUE}`, label: '未设置', count: none, active: current.includes(null), muted: true });
    return nodes;
  };

  const onTag = (node: NavNode, additive: boolean) => {
    const key = node.id.slice(4);
    const untagged = key === '__untagged__';
    const pathLabel = untagged ? null : (node.title ?? node.label);
    const active = untagged ? sel.untagged : sel.tagPaths.some((p) => tagKey(p) === key);
    const isThis = (x: Q) => (untagged ? x.k === 'untagged' : x.k === 'tag' && x.paths.length === 1 && tagKey(x.paths[0]!) === key);
    if (additive) {
      // 标签之间取“且”：追加一个条件；已选中则去掉它
      go(active ? removeRows(q, rows, (r) => !r.negated && isThis(r.q)) : appendCondition(q, tagCondition(pathLabel)));
      return;
    }
    const tagRows = rows.filter((r) => !r.negated && (r.q.k === 'tag' || r.q.k === 'untagged'));
    go(setFieldCondition(q, qctx.qc, scope, { reserved: 'tag' }, active && tagRows.length === 1 ? null : tagCondition(pathLabel)));
  };

  const onValue = (kind: 'subject' | 'stage') => (node: NavNode, additive: boolean) => {
    const raw = node.id.slice(kind.length + 1);
    const current = sel[kind].map((v) => (v === null ? NONE_VALUE : v));
    toggleField({ reserved: kind }, current, raw, additive, (values) => fieldText(kind === 'subject' ? '学科' : '学段', values.map((v) => (v === NONE_VALUE ? '无' : v))));
  };

  const onProp = (def: PropertyDefDTO) => (node: NavNode, additive: boolean) => {
    const value = node.id.slice(`prop:${def.id}:`.length);
    toggleField({ propertyId: def.id }, [...(sel.props.get(def.id) ?? [])], value, additive, (values) => propCondition(def, values));
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

  /** 属性标题的右键菜单：不在左侧栏列出（提示里可撤销）、到数据管理里编辑 */
  const hideProperty = async (def: PropertyDefDTO) => {
    const set = (showInNav: boolean) => sendJSON('PUT', `/api/properties/${def.id}`, { showInNav }).then(() => invalidateWrites(CATALOG_ONLY));
    try {
      await set(false);
      toast(`左侧栏不再列出“${def.name}”，可以在数据管理里重新打开`, 'success', {
        label: '撤销',
        onClick: () => void set(true).catch((err: unknown) => toast(errorMessage(err), 'error')),
      });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const manageItem = (item: string, label: string) => (
    <ContextItem onSelect={() => navigate(`/manage?item=${encodeURIComponent(item)}`)}>
      <SlidersHorizontal size={13} /> {label}
    </ContextItem>
  );

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
        <NavItem
          to="/lessons"
          icon={<NotebookText size={17} />}
          match={(p) => p.startsWith('/lessons')}
          count={lessons.data ? <span className="tree-count">{lessons.data.length}</span> : null}
        >
          教案
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
        <Section id="tags" title={`${noun}标签`} menu={manageItem('tags', '在数据管理中整理标签')}>
          {tagTree.length ? (
            <NavTree label={`${noun}标签树`} nodes={tagTree} storageKey={`sworks.nav.tags.${collection}`} onSelect={onTag} onDropItems={(n, ids) => void dropOnTag(n, ids)} />
          ) : (
            <p className="px-3 text-xs text-ink-faint">{nav.isLoading ? '加载中…' : '还没有标签。标签可用 / 分层，例如“方法/换元”。'}</p>
          )}
        </Section>
        <SavedSearchesNav
          scope={scope}
          currentQ={q}
          onOpen={(ss) => go(ss.text, ss.sort ?? 'auto')}
          section={(children) => (
            <Section id={`saved-${scope}`} title="常用检索">
              {children}
            </Section>
          )}
        />
        {navDefs.map((def) => {
          const nodes = propertyNodes(def, data, [...(sel.props.get(def.id) ?? [])]);
          return nodes.length ? (
            <Section
              key={def.id}
              id={`prop-${def.id}`}
              title={def.name}
              menu={
                <>
                  <ContextItem onSelect={() => void hideProperty(def)}>
                    <EyeOff size={13} /> 不在左侧栏列出
                  </ContextItem>
                  {manageItem(def.id, `在数据管理中编辑“${def.name}”`)}
                </>
              }
            >
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
          <Section id="subjects" title="按学科" menu={manageItem('subject', '在数据管理中整理学科')}>
            <NavTree label="学科筛选树" nodes={valueNodes('subject')} storageKey="sworks.nav.subjects" onSelect={onValue('subject')} />
          </Section>
        ) : null}
        {valueNodes('stage').length ? (
          <Section id="stages" title="按学段" menu={manageItem('stage', '在数据管理中整理学段')}>
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
        <NavItem to="/settings" icon={<Settings size={16} />} match={(p) => p.startsWith('/settings')}>
          设置
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
