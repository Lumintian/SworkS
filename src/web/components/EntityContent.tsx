/** 只读显示题目/资料的内容块与笔记（快速预览与教案共用）。 */
import type { MaterialDTO, ProblemDTO } from '@shared/api';
import type { NoteType } from '@shared/constants';
import { assetUrl } from '../lib/api';
import { MarkdownAssetsContext, MarkdownView } from '../markdown/MarkdownView';
import { NotesTabs } from './NotesTabs';

export function EntityContent({ entity: e, preferredNoteTab }: { entity: ProblemDTO | MaterialDTO; preferredNoteTab?: NoteType | undefined }) {
  return (
    <MarkdownAssetsContext.Provider value={{ remoteImageUrls: e.remoteImageUrls, remoteImages: e.remoteImages }}>
      <div className="space-y-4">
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
            <NotesTabs key={e.id} notes={e.notes} preferred={preferredNoteTab} />
          </div>
        ) : null}
      </div>
    </MarkdownAssetsContext.Provider>
  );
}
