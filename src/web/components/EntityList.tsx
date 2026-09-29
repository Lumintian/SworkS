/**
 * 题目/资料列表（参照 Notebook Navigator 的列表区）：
 * 查询语言输入框（条件都写在框里，导航点击也是改写它）+ 条件面板，按时间或相关度排序，
 * 多选（勾选、Shift 连选、⌘/Ctrl+A、选择全部 N 项），
 * 批量操作、右键菜单、快速预览（空格）与键盘导航；返回列表时恢复滚动位置与焦点。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ChevronDown, Download, ExternalLink, Eye, Search, SquareCheck, Trash2, UserRound, X } from 'lucide-react';
import type { ListItemDTO } from '@shared/api';
import { hasActiveFilters } from '@shared/listFilters';
import { navSelection, rowsOf, setFieldCondition, STUDENT_STATE_LABEL } from '@shared/query';
import { ATTEMPT_FILTER_LABELS, ATTEMPT_FILTERS, MATERIAL_STATUS_LABELS, type MaterialStatus } from '@shared/constants';
import { errorMessage } from '../lib/api';
import { exportProblems } from '../lib/exportMarkdown';
import { dateGroupLabel } from '../lib/format';
import { hasOpenOverlay, isEditableTarget, MOD_LABEL, useKeydown } from '../lib/hotkeys';
import { fetchAllIds, listParams, useInfiniteList, useListFilters, useStudents, type Collection } from '../lib/queries';
import { useRouter } from '../lib/router';
import { hasLegacyFilters, migrateLegacyFilters, tagCondition, useQueryContext } from '../lib/queryText';
import { propertiesFor } from '../lib/useCatalog';
import { useSelection } from '../lib/useSelection';
import { BatchBar, useBatchRunner } from './list/BatchBar';
import { ListRow } from './list/ListRow';
import { ConditionPanel } from './search/ConditionPanel';
import { QueryInput, type QueryInputHandle } from './search/QueryInput';
import { QuickLook } from './list/QuickLook';
import { ContextItem, ContextSeparator, DropdownContent, DropdownItem, DropdownMenu, DropdownSeparator, DropdownTrigger } from './Menu';
import { EmptyState, ErrorBox, Spinner, useConfirm, useToast } from './ui';

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
  const searchRef = useRef<QueryInputHandle>(null);
  const qctx = useQueryContext();
  const { catalog } = qctx;
  const scope = collection === 'problems' ? 'problem' : 'material';
  const defsMap = useMemo(() => new Map(catalog.properties.map((d) => [d.id, d])), [catalog.properties]);
  // 可以按选项顺序排序的属性：单选（例如难度、题型；分层时按选项树顺序）
  const sortDefs = propertiesFor(catalog, collection).filter((d) => d.type === 'select');
  const students = useStudents();
  const firstPage = query.data?.pages[0];
  const sortApplied = firstPage?.sortApplied ?? (urlFilters.sort === 'auto' ? 'created' : urlFilters.sort);
  const diagnostics = firstPage?.diagnostics ?? [];
  // “按学生查看”的上下文：地址栏的 student 参数，或查询里第一个正向的学生条件
  const studentId = urlFilters.student || firstPage?.studentId || '';
  const student = studentId ? qctx.students.find((s) => s.id === studentId) : undefined;
  const rows = useMemo(() => (qctx.ready ? rowsOf(urlFilters.q, qctx.qc, scope) : []), [urlFilters.q, qctx.ready, qctx.qc, scope]);
  const attemptState = navSelection(rows).student;

  // 旧书签里的筛选参数（tag=、subject=、prop=…）在目录加载后转成查询文本
  useEffect(() => {
    if (qctx.ready && hasLegacyFilters(urlFilters)) setFilters(migrateLegacyFilters(urlFilters, qctx));
  }, [qctx, urlFilters, setFilters]);
  const setQ = useCallback((q: string) => setFilters({ ...urlFilters, q }), [setFilters, urlFilters]);

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
    (name: string) => setQ(setFieldCondition(urlFilters.q, qctx.qc, scope, { reserved: 'tag' }, tagCondition(name))),
    [setQ, urlFilters.q, qctx.qc, scope],
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
  const sortField = sortApplied === 'updated' ? 'updatedAt' : 'createdAt';
  // 按属性或相关度排序时不按时间分组
  const groupByDate = sortApplied === 'created' || sortApplied === 'updated';
  const hasFreeText = sortApplied === 'relevance' || rows.some((r) => r.kind === 'text' && !r.negated);
  const setAttempt = (state: (typeof ATTEMPT_FILTERS)[number] | '') => {
    if (!student) return;
    const label = qctx.students.filter((x) => x.name === student.name).length > 1 ? `${student.name}#${student.id.slice(0, 4)}` : student.name;
    const cond = state ? `学生:${state === 'done' ? label : `${label}/${STUDENT_STATE_LABEL[state]}`}` : null;
    setFilters({ ...urlFilters, student: student.id, q: setFieldCondition(urlFilters.q, qctx.qc, scope, { reserved: 'student' }, cond) });
  };
  const quickIndex = quickId ? ids.indexOf(quickId) : -1;

  return (
    <div className="space-y-4">
      <div className="card-flat space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="query-box relative flex min-w-[14rem] flex-1 items-center">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-ink-faint" />
            <QueryInput
              ref={searchRef}
              value={urlFilters.q}
              onChange={(q) => {
                if (q !== urlFilters.q) setQ(q);
              }}
              ctx={qctx}
              scope={scope}
              placeholder={collection === 'problems' ? '搜索：函数 最值  #方法/换元  题型:完型填空  -有:答案 …' : '搜索资料：标题、内容、图片说明、标签，也可写 状态:待整理 等条件'}
              onArrowDown={() => {
                if (ids[0]) setFocusedId(ids[0]);
              }}
            />
          </div>
          <ConditionPanel text={urlFilters.q} onChange={setQ} ctx={qctx} scope={scope} onEditInText={(from, to) => searchRef.current?.select(from, to)} />
          {hasFilters ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setFilters({ ...urlFilters, q: '', attempt: '' })}>
              <X size={14} /> 清除筛选
            </button>
          ) : null}
        </div>
        {diagnostics.length ? (
          <ul className="space-y-0.5 text-xs" aria-label="查询提示" data-testid="query-diagnostics">
            {diagnostics.slice(0, 4).map((d, i) => (
              <li key={i} className={`flex items-start gap-1.5 ${d.severity === 'error' ? 'text-terracotta' : 'text-ochre'}`}>
                <AlertTriangle size={13} className="mt-0.5 flex-none" />
                <span>
                  <code className="rounded bg-sunken px-1">{urlFilters.q.slice(d.from, d.to) || '…'}</code> {d.message}
                  {d.suggestions?.length ? `（例如：${d.suggestions.slice(0, 4).join('、')}）` : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <div className="segmented" role="group" aria-label="排序">
            {hasFreeText ? (
              <button type="button" aria-pressed={sortApplied === 'relevance'} onClick={() => setFilters({ ...urlFilters, sort: 'relevance' })}>
                相关度
              </button>
            ) : null}
            <button type="button" aria-pressed={sortApplied === 'created'} onClick={() => setFilters({ ...urlFilters, sort: 'created' })}>
              最近添加
            </button>
            <button type="button" aria-pressed={sortApplied === 'updated'} onClick={() => setFilters({ ...urlFilters, sort: 'updated' })}>
              最近修改
            </button>
            {sortDefs.map((d) => (
              <button key={d.id} type="button" aria-pressed={sortApplied === `prop:${d.id}`} onClick={() => setFilters({ ...urlFilters, sort: `prop:${d.id}` })}>
                按{d.name}
              </button>
            ))}
          </div>
          {collection === 'problems' ? (
            <>
              <DropdownMenu>
                <DropdownTrigger asChild>
                  <button type="button" className={`btn btn-sm ${studentId ? 'btn-sage' : 'btn-ghost'}`}>
                    <UserRound size={14} /> {student ? `按“${student.name}”的作答查看` : studentId ? '按学生查看（已归档）' : '按学生查看'}
                    <ChevronDown size={13} />
                  </button>
                </DropdownTrigger>
                <DropdownContent>
                  {students.data?.map((s) => (
                    <DropdownItem key={s.id} checked={s.id === studentId} onSelect={() => setFilters({ ...urlFilters, student: s.id })}>
                      {s.name}
                    </DropdownItem>
                  ))}
                  {students.data?.length ? null : <DropdownItem disabled onSelect={() => undefined}>还没有学生</DropdownItem>}
                  {studentId ? (
                    <>
                      <DropdownSeparator />
                      <DropdownItem onSelect={() => setFilters({ ...urlFilters, student: '', q: setFieldCondition(urlFilters.q, qctx.qc, scope, { reserved: 'student' }, null) })}>
                        不按学生查看
                      </DropdownItem>
                    </>
                  ) : null}
                </DropdownContent>
              </DropdownMenu>
              {student ? (
                <div className="segmented" role="group" aria-label="作答状态">
                  <button type="button" aria-pressed={!attemptState} onClick={() => setAttempt('')}>
                    全部
                  </button>
                  {ATTEMPT_FILTERS.map((f) => (
                    <button key={f} type="button" aria-pressed={attemptState?.id === student.id && attemptState.state === f} onClick={() => setAttempt(f)}>
                      {ATTEMPT_FILTER_LABELS[f]}
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
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
        <EmptyState title={hasFilters ? '没有符合条件的内容' : emptyTitle}>
          {hasFilters ? (diagnostics.some((d) => d.severity === 'error') ? '查询里有无法识别的条件，见上方提示。' : '试试减少关键词或筛选条件。') : emptyHint}
        </EmptyState>
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
        hits={quickId ? items.find((i) => i.id === quickId)?.hits : undefined}
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
