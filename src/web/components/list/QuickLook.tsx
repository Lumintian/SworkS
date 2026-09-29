/** 快速预览：在列表里按空格查看题目（含答案、解析、笔记）或资料的完整内容，不离开列表。 */
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import type { MaterialDTO, ProblemDTO } from '@shared/api';
import { NOTE_TAB_ORDER, type SearchField } from '@shared/constants';
import { assetUrl, errorMessage, getJSON } from '../../lib/api';
import { formatTime } from '../../lib/format';
import { useCatalog } from '../../lib/useCatalog';
import { isEditableTarget, useKeydown } from '../../lib/hotkeys';
import type { Collection } from '../../lib/queries';
import { MarkdownAssetsContext, MarkdownView } from '../../markdown/MarkdownView';
import { NotesTabs } from '../NotesTabs';
import { Dialog, ErrorBox, Spinner } from '../ui';

export function QuickLook({
  collection,
  id,
  onClose,
  onOpen,
  onPrev,
  onNext,
  hits,
}: {
  collection: Collection;
  id: string | null;
  /** 列表项的检索命中字段：命中答案/解析/笔记时，默认打开对应的栏 */
  hits?: readonly SearchField[] | undefined;
  onClose: () => void;
  onOpen: (id: string) => void;
  onPrev?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  const q = useQuery({
    queryKey: ['entity', collection, id],
    queryFn: () => getJSON<ProblemDTO | MaterialDTO>(`/api/${collection}/${id}`),
    enabled: id !== null,
    staleTime: 0,
  });
  const e = q.data;
  const catalog = useCatalog();
  const propText = (e?.properties ?? []).flatMap((v) => {
    const def = catalog.properties.find((d) => d.id === v.propertyId);
    if (!def) return [];
    const shown = v.optionIds
      ? v.optionIds.map((id) => def.options.find((o) => o.id === id)?.path ?? '').filter(Boolean).join('、')
      : v.checked
        ? '是'
        : String(v.text ?? v.date ?? v.number ?? '');
    return [`${def.name}：${shown}`];
  });
  useKeydown((ev) => {
    if (isEditableTarget(ev.target) || ev.metaKey || ev.ctrlKey || ev.altKey) return false;
    if ((ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' || ev.key === 'k') && onPrev) {
      onPrev();
      return true;
    }
    if ((ev.key === 'ArrowRight' || ev.key === 'ArrowDown' || ev.key === 'j') && onNext) {
      onNext();
      return true;
    }
    if (ev.key === ' ') {
      onClose();
      return true;
    }
    return false;
  }, id !== null);
  const noun = collection === 'problems' ? '题目' : '资料';
  return (
    <Dialog
      open={id !== null}
      onClose={onClose}
      wide
      title={e ? (e.title ?? `未命名${noun}`) : '快速预览'}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-ink-faint">← → 切换 · 空格或 Esc 关闭</span>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!onPrev} onClick={onPrev} aria-label="上一项">
            <ChevronLeft size={15} />
          </button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!onNext} onClick={onNext} aria-label="下一项">
            <ChevronRight size={15} />
          </button>
          {id ? (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpen(id)}>
              <ExternalLink size={14} /> 打开编辑
            </button>
          ) : null}
        </>
      }
    >
      <div data-testid="quick-look">
        {q.isLoading ? <Spinner /> : null}
        {q.isError ? <ErrorBox message={errorMessage(q.error)} /> : null}
        {e ? (
          <MarkdownAssetsContext.Provider value={{ remoteImageUrls: e.remoteImageUrls, remoteImages: e.remoteImages }}>
            <div className="space-y-4">
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-faint">
                {e.subject ? <span>{e.subject}</span> : null}
                {e.stage ? <span>{e.stage}</span> : null}
                {propText.map((t) => (
                  <span key={t} className="chip chip-clay">
                    {t}
                  </span>
                ))}
                {e.tags.map((t) => (
                  <span key={t} className="chip">
                    {t}
                  </span>
                ))}
                <span>修改于 {formatTime(e.updatedAt)}</span>
              </p>
              {e.blocks.length === 0 ? <p className="text-sm italic text-ink-faint">（没有内容）</p> : null}
              {e.blocks.map((b) => {
                if (b.kind === 'markdown') return <MarkdownView key={b.id} source={b.body ?? ''} />;
                if (b.kind === 'text')
                  return (
                    <p key={b.id} className="whitespace-pre-wrap text-[0.97rem] leading-7">
                      {b.body}
                    </p>
                  );
                const remote = b.remoteImageId ? e.remoteImages[b.remoteImageId] : undefined;
                const local = b.assetId ?? (remote?.status === 'archived' ? remote.assetId : null);
                return (
                  <figure key={b.id} className="space-y-1">
                    {local ? (
                      <img className="source-image" src={assetUrl(local)} alt={b.caption ?? '题目图片'} loading="lazy" />
                    ) : (
                      <span className="md-img-placeholder md-img-placeholder--warn">
                        <span className="md-img-placeholder__title">图片尚未归档</span>
                        {remote ? <span className="md-img-placeholder__url">{remote.url}</span> : null}
                      </span>
                    )}
                    {b.caption ? <figcaption className="text-xs text-ink-faint">{b.caption}</figcaption> : null}
                  </figure>
                );
              })}
              {'notes' in e && e.notes.length ? (
                <div className="border-t border-line pt-4">
                  <NotesTabs key={e.id} notes={e.notes} preferred={NOTE_TAB_ORDER.find((t) => hits?.includes(t))} />
                </div>
              ) : null}
            </div>
          </MarkdownAssetsContext.Provider>
        ) : null}
      </div>
    </Dialog>
  );
}
