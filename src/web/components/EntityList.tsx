/** 题目/资料列表：关键词 + 学科 + 学段 + 多标签（AND）组合筛选，最近添加/最近修改排序，分页加载。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ImageOff, Search, X } from 'lucide-react';
import type { ListItemDTO, ListResponse } from '@shared/api';
import { MATERIAL_STATUS_LABELS, NOTE_TYPE_LABELS, PAGE_SIZE, SEARCH_FIELD_LABELS, type MaterialStatus, type SearchField } from '@shared/constants';
import { assetUrl, errorMessage, getJSON } from '../lib/api';
import { formatTime } from '../lib/format';
import { Link, useRouter } from '../lib/router';
import { useCatalog } from '../lib/useCatalog';
import { EmptyState, ErrorBox, Spinner } from './ui';

interface Filters {
  q: string;
  subject: string;
  stage: string;
  tags: string[];
  sort: 'created' | 'updated';
}

function readFilters(search: string): Filters {
  const p = new URLSearchParams(search);
  return {
    q: p.get('q') ?? '',
    subject: p.get('subject') ?? '',
    stage: p.get('stage') ?? '',
    tags: (p.get('tags') ?? '').split(',').filter(Boolean),
    sort: p.get('sort') === 'updated' ? 'updated' : 'created',
  };
}

function writeFilters(f: Filters): string {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.subject) p.set('subject', f.subject);
  if (f.stage) p.set('stage', f.stage);
  if (f.tags.length) p.set('tags', f.tags.join(','));
  if (f.sort !== 'created') p.set('sort', f.sort);
  const s = p.toString();
  return s ? `?${s}` : '';
}

function HitBadges({ item }: { item: ListItemDTO }) {
  if (item.hits.length === 0) return null;
  const inNotes: SearchField[] = item.hits.filter((h) => h === 'note' || h === 'answer' || h === 'solution');
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs" data-testid="hit-badges">
      {inNotes.length > 0 ? <span className="chip chip-clay">命中{inNotes.map((h) => SEARCH_FIELD_LABELS[h]).join('/')}</span> : null}
      {item.hits
        .filter((h) => !inNotes.includes(h))
        .map((h) => (
          <span key={h} className="chip chip-stone">
            命中{SEARCH_FIELD_LABELS[h]}
          </span>
        ))}
    </span>
  );
}

function Row({
  item,
  href,
  placeholder,
  selectable,
  checked,
  onCheck,
}: {
  item: ListItemDTO;
  href: string;
  placeholder: string;
  selectable: boolean;
  checked: boolean;
  onCheck: () => void;
}) {
  return (
    <li className="card flex gap-3 px-3 py-3 transition-shadow hover:shadow-[var(--shadow-lift)] sm:gap-4 sm:px-4" data-testid="list-item">
      {selectable ? (
        <input type="checkbox" className="mt-1 h-4 w-4 flex-none accent-[var(--color-sage-deep)]" checked={checked} onChange={onCheck} aria-label={`选择 ${item.title ?? placeholder}`} />
      ) : null}
      <Link to={href} className="flex-none" tabIndex={-1} aria-hidden="true">
        {item.firstImageAssetId ? (
          <img className="thumb" src={assetUrl(item.firstImageAssetId)} alt="" loading="lazy" />
        ) : (
          <span className="thumb flex items-center justify-center text-ink-faint">{item.imageCount > 0 ? <ImageOff size={20} /> : <span className="font-serif text-2xl text-line-strong">¶</span>}</span>
        )}
      </Link>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link to={href} className={`truncate font-serif text-[1.02rem] font-semibold hover:underline ${item.title ? 'text-stone' : 'italic text-ink-soft'}`}>
            {item.title ?? placeholder}
          </Link>
          {item.status ? <span className={`chip ${item.status === 'inbox' ? 'chip-warn' : 'chip-stone'}`}>{MATERIAL_STATUS_LABELS[item.status]}</span> : null}
          <HitBadges item={item} />
        </div>
        <p className="line-clamp-2 text-sm text-ink-soft">{item.summary || (item.imageCount ? `${item.imageCount} 张图片` : '（无文字内容）')}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
          {item.subject ? <span>{item.subject}</span> : null}
          {item.stage ? <span>{item.stage}</span> : null}
          {item.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
          {item.noteCounts
            ? (['answer', 'solution', 'note'] as const)
                .filter((k) => item.noteCounts![k] > 0)
                .map((k) => (
                  <span key={k}>
                    {NOTE_TYPE_LABELS[k]} {item.noteCounts![k]}
                  </span>
                ))
            : null}
          <span className="ml-auto">添加 {formatTime(item.createdAt)}</span>
          <span>修改 {formatTime(item.updatedAt)}</span>
        </div>
      </div>
    </li>
  );
}

export function EntityList({
  collection,
  status,
  placeholder,
  emptyTitle,
  emptyHint,
  selectionActions,
}: {
  collection: 'problems' | 'materials';
  status?: MaterialStatus;
  placeholder: string;
  emptyTitle: string;
  emptyHint: ReactNode;
  selectionActions?: (ids: string[], clear: () => void) => ReactNode;
}) {
  const { path, search, navigate } = useRouter();
  const filters = useMemo(() => readFilters(search), [search]);
  const [qInput, setQInput] = useState(filters.q);
  const [items, setItems] = useState<ListItemDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const catalog = useCatalog();
  const reqSeq = useRef(0);
  const [reloadKey, setReloadKey] = useState(0);

  const setFilters = useCallback((f: Filters) => navigate(`${path}${writeFilters(f)}`, { replace: true }), [navigate, path]);

  const query = useCallback(
    (offset: number) => {
      const p = new URLSearchParams();
      if (filters.q) p.set('q', filters.q);
      if (filters.subject) p.set('subject', filters.subject);
      if (filters.stage) p.set('stage', filters.stage);
      if (filters.tags.length) p.set('tags', filters.tags.join(','));
      if (status) p.set('status', status);
      p.set('sort', filters.sort);
      p.set('offset', String(offset));
      p.set('limit', String(PAGE_SIZE));
      return getJSON<ListResponse>(`/api/${collection}?${p.toString()}`);
    },
    [collection, filters, status],
  );

  useEffect(() => {
    const seq = ++reqSeq.current;
    setPhase('loading');
    query(0).then(
      (r) => {
        if (seq !== reqSeq.current) return;
        setItems(r.items);
        setTotal(r.total);
        setPhase('ready');
      },
      (err) => {
        if (seq !== reqSeq.current) return;
        setError(errorMessage(err));
        setPhase('error');
      },
    );
  }, [query, reloadKey]);

  // 关键词输入防抖
  useEffect(() => {
    if (qInput === filters.q) return;
    const t = window.setTimeout(() => setFilters({ ...filters, q: qInput.trim() }), 300);
    return () => window.clearTimeout(t);
  }, [qInput, filters, setFilters]);

  const tagOptions = catalog.tags.filter((t) => (collection === 'problems' ? t.problemCount : t.materialCount) > 0 || filters.tags.includes(t.id));
  const hasFilters = Boolean(filters.q || filters.subject || filters.stage || filters.tags.length);

  return (
    <div className="space-y-4">
      <div className="card-flat space-y-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative min-w-[14rem] flex-1">
            <span className="sr-only">搜索</span>
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              className="input pl-9"
              type="search"
              value={qInput}
              placeholder={collection === 'problems' ? '搜索标题、题干、笔记、答案、解析、标签…（空格分隔表示同时包含）' : '搜索资料标题、内容、图片说明、标签…'}
              onChange={(e) => setQInput(e.target.value)}
              data-testid="search-input"
            />
          </label>
          <div className="segmented" role="group" aria-label="排序">
            <button type="button" aria-pressed={filters.sort === 'created'} onClick={() => setFilters({ ...filters, sort: 'created' })}>
              最近添加
            </button>
            <button type="button" aria-pressed={filters.sort === 'updated'} onClick={() => setFilters({ ...filters, sort: 'updated' })}>
              最近修改
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select className="select w-auto py-1" value={filters.subject} aria-label="学科" onChange={(e) => setFilters({ ...filters, subject: e.target.value })}>
            <option value="">全部学科</option>
            {catalog.subjects.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select className="select w-auto py-1" value={filters.stage} aria-label="学段" onChange={(e) => setFilters({ ...filters, stage: e.target.value })}>
            <option value="">全部学段</option>
            {catalog.stages.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          {tagOptions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="标签筛选">
              {tagOptions.map((t) => {
                const on = filters.tags.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    aria-pressed={on}
                    className={`chip border ${on ? 'border-sage-deep bg-sage text-white' : 'border-transparent'}`}
                    onClick={() => setFilters({ ...filters, tags: on ? filters.tags.filter((x) => x !== t.id) : [...filters.tags, t.id] })}
                  >
                    {t.name}
                  </button>
                );
              })}
              {filters.tags.length > 1 ? <span className="text-xs text-ink-faint">包含全部所选标签</span> : null}
            </div>
          ) : null}
          {hasFilters ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm ml-auto"
              onClick={() => {
                setQInput('');
                setFilters({ q: '', subject: '', stage: '', tags: [], sort: filters.sort });
              }}
            >
              <X size={14} /> 清除筛选
            </button>
          ) : null}
        </div>
      </div>

      {selectionActions && selected.size > 0 ? (
        <div className="card-flat flex flex-wrap items-center gap-3 bg-sage-soft px-4 py-2 text-sm">
          <span>已选 {selected.size} 项</span>
          {selectionActions([...selected], () => setSelected(new Set()))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            取消选择
          </button>
        </div>
      ) : null}

      {phase === 'loading' ? <Spinner /> : null}
      {phase === 'error' ? <ErrorBox message={error} onRetry={() => setReloadKey((k) => k + 1)} /> : null}
      {phase === 'ready' && items.length === 0 ? (
        <EmptyState title={hasFilters ? '没有符合条件的内容' : emptyTitle}>{hasFilters ? '试试减少关键词或筛选条件。' : emptyHint}</EmptyState>
      ) : null}
      {phase === 'ready' && items.length > 0 ? (
        <>
          <p className="text-xs text-ink-faint" data-testid="result-count">
            共 {total} 项{hasFilters ? '（已筛选）' : ''}
          </p>
          <ul className="space-y-3">
            {items.map((it) => (
              <Row
                key={it.id}
                item={it}
                href={`/${collection}/${it.id}`}
                placeholder={placeholder}
                selectable={Boolean(selectionActions)}
                checked={selected.has(it.id)}
                onCheck={() =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (n.has(it.id)) n.delete(it.id);
                    else n.add(it.id);
                    return n;
                  })
                }
              />
            ))}
          </ul>
          {items.length < total ? (
            <div className="flex justify-center">
              <button
                type="button"
                className="btn"
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  try {
                    const r = await query(items.length);
                    setItems((xs) => [...xs, ...r.items.filter((x) => !xs.some((y) => y.id === x.id))]);
                    setTotal(r.total);
                  } catch (err) {
                    setError(errorMessage(err));
                  } finally {
                    setLoadingMore(false);
                  }
                }}
              >
                {loadingMore ? '加载中…' : `加载更多（还有 ${total - items.length} 项）`}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
