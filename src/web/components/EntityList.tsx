/**
 * 题目/资料列表（参照 Notebook Navigator 的列表区）：
 * 关键词 + 导航树筛选（标签子树、学科、学段），按时间分组，多选（勾选、Shift 连选、⌘/Ctrl+A、选择全部 N 项），
 * 批量操作、右键菜单、快速预览（空格）与键盘导航；返回列表时恢复滚动位置与焦点。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Download, ExternalLink, Eye, Search, SquareCheck, Trash2, UserRound, X } from 'lucide-react';
import type { ListItemDTO } from '@shared/api';
import { hasActiveFilters, NONE_VALUE, TRUE_VALUE, type ListFilters } from '@shared/listFilters';
import { ATTEMPT_FILTER_LABELS, ATTEMPT_FILTERS, MATERIAL_STATUS_LABELS, type MaterialStatus } from '@shared/constants';
import { errorMessage } from '../lib/api';
import { exportProblems } from '../lib/exportMarkdown';
import { dateGroupLabel } from '../lib/format';
import { hasOpenOverlay, isEditableTarget, MOD_LABEL, useKeydown } from '../lib/hotkeys';
import { fetchAllIds, listParams, useInfiniteList, useListFilters, useStudents, type Collection } from '../lib/queries';
import { useRouter } from '../lib/router';
import { propertiesFor, useCatalog } from '../lib/useCatalog';
import { useSelection } from '../lib/useSelection';
import { BatchBar, useBatchRunner } from './list/BatchBar';
import { ListRow } from './list/ListRow';
import { TagLabel } from './TagLabel';
import { QuickLook } from './list/QuickLook';
import { ContextItem, ContextSeparator, DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger } from './Menu';
import { EmptyState, ErrorBox, Spinner, useConfirm, useToast } from './ui';

function FilterChip({ label, onRemove }: { label: ReactNode; onRemove: () => void }) {
  return (
    <span className="chip chip-stone gap-1 py-0.5 pl-2.5 pr-1">
      {label}
      <button type="button" className="rounded-full p-0.5 opacity-70 hover:bg-white/60 hover:opacity-100" aria-label="移除这个筛选条件" onClick={onRemove}>
        <X size={12} />
      </button>
    </span>
  );
}

function FilterChips({ filters, setFilters, onClearAll }: { filters: ListFilters; setFilters: (f: ListFilters) => void; onClearAll: () => void }) {
  const catalog = useCatalog();
  if (!hasActiveFilters(filters)) return null;
  const valueLabel = (kind: string, v: string) => (v === NONE_VALUE ? `${kind}：未设置` : `${kind}：${v}`);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-sm" aria-label="当前筛选条件">
      {filters.q ? <FilterChip label={`关键词：${filters.q}`} onRemove={() => setFilters({ ...filters, q: '' })} /> : null}
      {filters.tagPaths.map((p) => (
        <FilterChip
          key={p}
          label={
            <>
              #<TagLabel name={p} />
            </>
          }
          onRemove={() => setFilters({ ...filters, tagPaths: filters.tagPaths.filter((x) => x !== p) })}
        />
      ))}
      {filters.tagIds.map((id) => (
        <FilterChip
          key={id}
          label={`#${catalog.tags.find((t) => t.id === id)?.name ?? '标签'}`}
          onRemove={() => setFilters({ ...filters, tagIds: filters.tagIds.filter((x) => x !== id) })}
        />
      ))}
      {filters.untagged ? <FilterChip label="无标签" onRemove={() => setFilters({ ...filters, untagged: false })} /> : null}
      {filters.attempt ? <FilterChip label={`作答：${ATTEMPT_FILTER_LABELS[filters.attempt]}`} onRemove={() => setFilters({ ...filters, attempt: '' })} /> : null}
      {filters.props.map((pf) => {
        const def = catalog.properties.find((d) => d.id === pf.propertyId);
        const labels = pf.values.map((v) =>
          v === NONE_VALUE ? '未设置' : v === TRUE_VALUE ? '是' : (def?.options.find((o) => o.id === v)?.path ?? '已删除的选项'),
        );
        return (
          <FilterChip
            key={pf.propertyId}
            label={`${def?.name ?? '属性'}：${labels.join(' 或 ')}`}
            onRemove={() => setFilters({ ...filters, props: filters.props.filter((x) => x.propertyId !== pf.propertyId) })}
          />
        );
      })}
      {filters.subject ? <FilterChip label={valueLabel('学科', filters.subject)} onRemove={() => setFilters({ ...filters, subject: '' })} /> : null}
      {filters.stage ? <FilterChip label={valueLabel('学段', filters.stage)} onRemove={() => setFilters({ ...filters, stage: '' })} /> : null}
      {filters.tagPaths.length + filters.tagIds.length > 1 ? <span className="text-xs text-ink-faint">同时包含全部所选标签</span> : null}
      <button type="button" className="btn btn-ghost btn-sm ml-auto" onClick={onClearAll}>
        <X size={14} /> 清除筛选
      </button>
    </div>
  );
}

function scrollKey(path: string, search: string) {
  return `sworks.list.${path}${search}`;
}

export function EntityList({
  collection,
  status,
  placeholder,
  emptyTitle,
  emptyHint,
}: {
  collection: Collection;
  status?: MaterialStatus;
  placeholder: string;
  emptyTitle: string;
  emptyHint: ReactNode;
}) {
  const { path, search, navigate } = useRouter();
  const toast = useToast();
  const confirm = useConfirm();
  const run = useBatchRunner(collection);
  const [urlFilters, setFilters] = useListFilters();
  const filters = useMemo(() => ({ ...urlFilters, status }), [urlFilters, status]);
  const filterKey = listParams(filters);
  const query = useInfiniteList(collection, filters);
  const [qInput, setQInput] = useState(filters.q);
  const searchRef = useRef<HTMLInputElement>(null);
  const catalog = useCatalog();
  const defsMap = useMemo(() => new Map(catalog.properties.map((d) => [d.id, d])), [catalog.properties]);
  // 可以按选项顺序排序的属性：不分层的单选（例如难度、题型）
  const sortDefs = propertiesFor(catalog, collection).filter((d) => d.type === 'select' && !d.nested);
  const students = useStudents();
  const student = urlFilters.student ? students.data?.find((s) => s.id === urlFilters.student) : undefined;

  const items = useMemo(() => {
    const seen = new Set<string>();
    const out: ListItemDTO[] = [];
    for (const page of query.data?.pages ?? []) {
      for (const it of page.items) {
        if (seen.has(it.id)) continue;
        seen.add(it.id);
        out.push(it);
      }
    }
    return out;
  }, [query.data]);
  const total = query.data?.pages.at(-1)?.total ?? 0;
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const selection = useSelection(ids, filterKey);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [quickId, setQuickId] = useState<string | null>(null);
  // 快速预览里切换到的项，关闭后作为列表焦点
  useEffect(() => {
    if (quickId) setFocusedId(quickId);
  }, [quickId]);

  // 关键词输入防抖；地址栏变化（例如点导航树、浏览器后退）时同步输入框
  useEffect(() => setQInput(urlFilters.q), [urlFilters.q]);
  useEffect(() => {
    if (qInput.trim() === urlFilters.q) return;
    const t = window.setTimeout(() => setFilters({ ...urlFilters, q: qInput.trim() }), 300);
    return () => window.clearTimeout(t);
  }, [qInput, urlFilters, setFilters]);

  // 返回列表时恢复滚动位置与焦点
  const restored = useRef(false);
  const key = scrollKey(path, search);
  useLayoutEffect(() => {
    if (restored.current || items.length === 0) return;
    restored.current = true;
    try {
      const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { y: number; focused: string | null } | null;
      if (saved) {
        if (saved.focused && ids.includes(saved.focused)) setFocusedId(saved.focused);
        window.scrollTo(0, saved.y);
      }
    } catch {
      // 会话存储不可用时从顶部开始
    }
  }, [items.length, ids, key]);
  const focusRef = useRef(focusedId);
  focusRef.current = focusedId;
  useEffect(
    () => () => {
      try {
        sessionStorage.setItem(key, JSON.stringify({ y: window.scrollY, focused: focusRef.current }));
      } catch {
        // 忽略
      }
    },
    [key],
  );

  const hrefOf = useCallback((id: string) => `/${collection}/${id}`, [collection]);
  const moveFocus = (delta: number, extend: boolean) => {
    if (ids.length === 0) return;
    const i = focusedId ? ids.indexOf(focusedId) : -1;
    const next = ids[Math.min(Math.max(i + delta, 0), ids.length - 1)]!;
    setFocusedId(next);
    if (extend) {
      if (focusedId && !selection.has(focusedId)) selection.toggle(focusedId);
      selection.selectRange(next);
    }
    document.querySelector(`[data-id="${next}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  useKeydown((e) => {
    if (isEditableTarget(e.target) || hasOpenOverlay() || e.altKey) return false;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'a') {
      selection.setAll(ids);
      return true;
    }
    if (mod) return false;
    switch (e.key) {
      case 'j':
      case 'ArrowDown':
        moveFocus(1, e.shiftKey);
        return true;
      case 'k':
      case 'ArrowUp':
        moveFocus(-1, e.shiftKey);
        return true;
      case 'Enter':
        if (!focusedId) return false;
        navigate(hrefOf(focusedId));
        return true;
      case 'x':
        if (!focusedId) return false;
        selection.toggle(focusedId);
        return true;
      case ' ':
        if (!focusedId) return false;
        setQuickId(focusedId);
        return true;
      case '/':
        searchRef.current?.focus();
        return true;
      case 'Escape':
        if (selection.selected.size === 0) return false;
        selection.clear();
        return true;
      default:
        return false;
    }
  });

  const onCheck = useCallback(
    (id: string, range: boolean) => (range ? selection.selectRange(id) : selection.toggle(id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection.selectRange, selection.toggle],
  );
  const selectedRef = useRef(selection.selected);
  selectedRef.current = selection.selected;
  const dragIdsFor = useCallback((id: string) => () => (selectedRef.current.has(id) ? [...selectedRef.current] : [id]), []);
  const onTagClick = useCallback(
    (name: string) => setFilters({ ...urlFilters, tagPaths: [name], tagIds: [], untagged: false }),
    [setFilters, urlFilters],
  );

  const renderMenu = useCallback(
    (id: string) => {
      const target = selectedRef.current.has(id) ? [...selectedRef.current] : [id];
      const many = target.length > 1;
      const item = items.find((x) => x.id === id);
      return (
        <>
          <ContextItem onSelect={() => navigate(hrefOf(id))}>
            <ExternalLink size={14} /> 打开
          </ContextItem>
          <ContextItem onSelect={() => setQuickId(id)}>
            <Eye size={14} /> 快速预览<span className="kbd ml-auto">空格</span>
          </ContextItem>
          <ContextItem onSelect={() => selection.toggle(id)}>
            <SquareCheck size={14} /> {selectedRef.current.has(id) ? '取消选择' : '选择'}
            <span className="kbd ml-auto">X</span>
          </ContextItem>
          <ContextSeparator />
          {collection === 'problems' ? (
            <ContextItem
              onSelect={async () => {
                const r = await exportProblems(target);
                toast(r.message, r.tone);
              }}
            >
              <Download size={14} /> {many ? `导出所选 ${target.length} 道题` : '导出为 Markdown'}
            </ContextItem>
          ) : null}
          {collection === 'materials' && item?.status && !many ? (
            <ContextItem
              onSelect={() => {
                const s = item.status === 'inbox' ? 'active' : 'inbox';
                void run(target, { op: 'setStatus', status: s }, `已标为${MATERIAL_STATUS_LABELS[s]}：`);
              }}
            >
              标为{MATERIAL_STATUS_LABELS[item.status === 'inbox' ? 'active' : 'inbox']}
            </ContextItem>
          ) : null}
          <ContextItem
            danger
            onSelect={async () => {
              const ok = await confirm({
                title: '移到回收站',
                message: many ? `把所选的 ${target.length} 项移到回收站？之后可以在回收站恢复。` : '把这一项移到回收站？之后可以在回收站恢复。',
                confirmLabel: '移到回收站',
                danger: true,
              });
              if (!ok) return;
              const r = await run(target, { op: 'trash' }, '已移到回收站：');
              if (r) selection.clear();
            }}
          >
            <Trash2 size={14} /> {many ? `把所选 ${target.length} 项移到回收站` : '移到回收站'}
          </ContextItem>
        </>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, collection, hrefOf],
  );

  const selectAllMatching = async () => {
    try {
      const r = await fetchAllIds(collection, filters);
      selection.setAll(r.ids);
      if (r.truncated) toast(`一次最多选择 ${r.ids.length} 项，已选中前 ${r.ids.length} 项`, 'warn');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const hasFilters = hasActiveFilters(filters);
  const allLoadedSelected = ids.length > 0 && ids.every((id) => selection.has(id));
  const sortField = filters.sort === 'updated' ? 'updatedAt' : 'createdAt';
  // 按属性排序时不按时间分组
  const groupByDate = filters.sort === 'created' || filters.sort === 'updated';
  const quickIndex = quickId ? ids.indexOf(quickId) : -1;

  return (
    <div className="space-y-4">
      <div className="card-flat space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[14rem] flex-1">
            <span className="sr-only">搜索</span>
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              ref={searchRef}
              className="input pl-9"
              type="search"
              value={qInput}
              placeholder={collection === 'problems' ? '搜索标题、题干、笔记、答案、解析、标签…（空格分隔表示同时包含）' : '搜索资料标题、内容、图片说明、标签…'}
              onChange={(e) => setQInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
                if (e.key === 'ArrowDown') {
                  (e.target as HTMLInputElement).blur();
                  if (ids[0]) setFocusedId(ids[0]);
                }
              }}
              data-testid="search-input"
            />
          </label>
          <div className="segmented" role="group" aria-label="排序">
            <button type="button" aria-pressed={filters.sort === 'created'} onClick={() => setFilters({ ...urlFilters, sort: 'created' })}>
              最近添加
            </button>
            <button type="button" aria-pressed={filters.sort === 'updated'} onClick={() => setFilters({ ...urlFilters, sort: 'updated' })}>
              最近修改
            </button>
            {sortDefs.map((d) => (
              <button key={d.id} type="button" aria-pressed={filters.sort === `prop:${d.id}`} onClick={() => setFilters({ ...urlFilters, sort: `prop:${d.id}` })}>
                按{d.name}
              </button>
            ))}
          </div>
        </div>
        {collection === 'problems' ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <DropdownMenu>
              <DropdownTrigger asChild>
                <button type="button" className={`btn btn-sm ${urlFilters.student ? 'btn-sage' : 'btn-ghost'}`}>
                  <UserRound size={14} /> {student ? `按“${student.name}”的作答查看` : urlFilters.student ? '按学生查看（已归档）' : '按学生查看'}
                  <ChevronDown size={13} />
                </button>
              </DropdownTrigger>
              <DropdownContent>
                {students.data?.map((s) => (
                  <DropdownItem key={s.id} checked={s.id === urlFilters.student} onSelect={() => setFilters({ ...urlFilters, student: s.id })}>
                    {s.name}
                  </DropdownItem>
                ))}
                {students.data?.length ? null : <DropdownItem disabled onSelect={() => undefined}>还没有学生</DropdownItem>}
                {urlFilters.student ? (
                  <>
                    <DropdownSeparator />
                    <DropdownItem onSelect={() => setFilters({ ...urlFilters, student: '', attempt: '' })}>不按学生查看</DropdownItem>
                  </>
                ) : null}
              </DropdownContent>
            </DropdownMenu>
            {urlFilters.student ? (
              <div className="segmented" role="group" aria-label="作答状态">
                <button type="button" aria-pressed={!urlFilters.attempt} onClick={() => setFilters({ ...urlFilters, attempt: '' })}>
                  全部
                </button>
                {ATTEMPT_FILTERS.map((f) => (
                  <button key={f} type="button" aria-pressed={urlFilters.attempt === f} onClick={() => setFilters({ ...urlFilters, attempt: f })}>
                    {ATTEMPT_FILTER_LABELS[f]}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <FilterChips
          filters={urlFilters}
          setFilters={setFilters}
          onClearAll={() => {
            setQInput('');
            setFilters({ ...urlFilters, q: '', subject: '', stage: '', tagPaths: [], tagIds: [], untagged: false, props: [], attempt: '' });
          }}
        />
      </div>

      {selection.selected.size > 0 ? (
        <BatchBar
          collection={collection}
          ids={[...selection.selected]}
          items={items}
          total={total}
          onSelectAllMatching={total > ids.length ? () => void selectAllMatching() : undefined}
          onClear={selection.clear}
        />
      ) : null}

      {query.isPending ? <Spinner /> : null}
      {query.isError ? <ErrorBox message={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : null}
      {query.isSuccess && items.length === 0 ? (
        <EmptyState title={hasFilters ? '没有符合条件的内容' : emptyTitle}>{hasFilters ? '试试减少关键词或筛选条件。' : emptyHint}</EmptyState>
      ) : null}
      {items.length > 0 ? (
        <>
          <div className="flex flex-wrap items-center gap-3 text-xs text-ink-faint">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-[var(--color-sage-deep)]"
                checked={allLoadedSelected}
                onChange={() => (allLoadedSelected ? selection.clear() : selection.setAll(ids))}
                aria-label="全选已加载的项"
              />
              全选
            </label>
            <span data-testid="result-count">
              共 {total} 项{hasFilters ? '（已筛选）' : ''}
            </span>
            <span className="ml-auto hidden lg:inline">
              <span className="kbd">J</span>/<span className="kbd">K</span> 移动 · <span className="kbd">X</span> 选择 · <span className="kbd">空格</span> 预览 ·{' '}
              <span className="kbd">Enter</span> 打开 · <span className="kbd">{MOD_LABEL} K</span> 查找
            </span>
          </div>
          <ul className="space-y-3">
            {items.map((it, i) => {
              const label = dateGroupLabel(it[sortField]);
              const showHeader = groupByDate && (i === 0 || dateGroupLabel(items[i - 1]![sortField]) !== label);
              return (
                <GroupedRow key={it.id} header={showHeader ? label : null}>
                  <ListRow
                    item={it}
                    href={hrefOf(it.id)}
                    placeholder={placeholder}
                    selected={selection.has(it.id)}
                    focused={focusedId === it.id}
                    dragIds={dragIdsFor(it.id)}
                    onCheck={onCheck}
                    onFocusRow={setFocusedId}
                    onTagClick={onTagClick}
                    defs={defsMap}
                    studentName={student?.name}
                    renderMenu={renderMenu}
                  />
                </GroupedRow>
              );
            })}
          </ul>
          {query.hasNextPage ? (
            <div className="flex justify-center">
              <button type="button" className="btn" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                {query.isFetchingNextPage ? '加载中…' : `加载更多（还有 ${total - items.length} 项）`}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      <QuickLook
        collection={collection}
        id={quickId}
        onClose={() => setQuickId(null)}
        onOpen={(id) => {
          setQuickId(null);
          navigate(hrefOf(id));
        }}
        onPrev={quickIndex > 0 ? () => setQuickId(ids[quickIndex - 1]!) : undefined}
        onNext={quickIndex >= 0 && quickIndex < ids.length - 1 ? () => setQuickId(ids[quickIndex + 1]!) : undefined}
      />
    </div>
  );
}

function GroupedRow({ header, children }: { header: string | null; children: ReactNode }) {
  if (!header) return <>{children}</>;
  return (
    <>
      <li className="pt-1 text-xs font-bold tracking-wide text-ink-faint" aria-hidden="true">
        {header}
      </li>
      {children}
    </>
  );
}
