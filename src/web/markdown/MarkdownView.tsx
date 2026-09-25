import { createContext, memo, useContext, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import type { RemoteImageDTO } from '@shared/api';
import { classifyImageUrl, parseAssetRef } from '@shared/assetRef';
import { REHYPE_PLUGINS, REMARK_PLUGINS } from './plugins';

/** 渲染 Markdown 图片时所需的附件/远程图片状态。 */
export interface MarkdownAssets {
  remoteImageUrls: Record<string, string>;
  remoteImages: Record<string, RemoteImageDTO>;
  onRetryRemote?: (id: string) => void;
  onManualRemote?: (id: string, file: File) => void;
}

const EMPTY: MarkdownAssets = { remoteImageUrls: {}, remoteImages: {} };
export const MarkdownAssetsContext = createContext<MarkdownAssets>(EMPTY);

function Placeholder({ tone, title, children }: { tone: 'warn' | 'pending'; title: string; children?: ReactNode }) {
  return (
    <span className={`md-img-placeholder md-img-placeholder--${tone}`} role="note">
      <span className="md-img-placeholder__title">{title}</span>
      {children}
    </span>
  );
}

function MdImage({ src, alt, title }: { src?: string | Blob; alt?: string; title?: string }) {
  const ctx = useContext(MarkdownAssetsContext);
  const url = typeof src === 'string' ? src : '';
  const kind = classifyImageUrl(url);
  if (kind === 'asset') {
    const id = parseAssetRef(url)!;
    return <img className="md-img" src={`/api/assets/${id}`} alt={alt ?? ''} title={title} loading="lazy" />;
  }
  if (kind === 'remote') {
    const rid = ctx.remoteImageUrls[url.trim()];
    const remote = rid ? ctx.remoteImages[rid] : undefined;
    if (remote?.status === 'archived' && remote.assetId) {
      return <img className="md-img" src={`/api/assets/${remote.assetId}`} alt={alt ?? ''} title={title} loading="lazy" />;
    }
    // 不悄悄回退到外链加载：只显示占位与原 URL
    const failed = remote?.status === 'failed';
    return (
      <Placeholder tone={failed ? 'warn' : 'pending'} title={failed ? '远程图片未归档' : remote ? '远程图片归档中…' : '远程图片（保存后归档）'}>
        <span className="md-img-placeholder__url">{url}</span>
        {failed && remote?.errorMessage ? <span className="md-img-placeholder__err">{remote.errorMessage}</span> : null}
        {failed && remote && (ctx.onRetryRemote || ctx.onManualRemote) ? (
          <span className="md-img-placeholder__actions">
            {ctx.onRetryRemote ? (
              <button type="button" className="link-btn" onClick={() => ctx.onRetryRemote!(remote.id)}>
                重试下载
              </button>
            ) : null}
            {ctx.onManualRemote ? (
              <label className="link-btn">
                手动补传
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="sr-only"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) ctx.onManualRemote!(remote.id, f);
                    e.target.value = '';
                  }}
                />
              </label>
            ) : null}
          </span>
        ) : null}
      </Placeholder>
    );
  }
  return (
    <Placeholder tone="warn" title="本地图片缺失，需要手动补传">
      <span className="md-img-placeholder__url">{url || '（空地址）'}</span>
    </Placeholder>
  );
}

function MdLink({ href, children, title }: { href?: string; children?: ReactNode; title?: string }) {
  const url = href ?? '';
  const asset = parseAssetRef(url);
  if (asset) {
    return (
      <a href={`/api/assets/${asset}`} target="_blank" rel="noopener noreferrer" title={title}>
        {children}
      </a>
    );
  }
  if (/^(https?:|mailto:)/i.test(url)) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer nofollow" title={title}>
        {children}
      </a>
    );
  }
  if (url.startsWith('#')) return <a href={url}>{children}</a>;
  // 其他相对链接在本系统中没有目标：显示为文字，保留原地址提示
  return (
    <span className="md-dead-link" title={url}>
      {children}
    </span>
  );
}

const COMPONENTS: Components = {
  img: MdImage as Components['img'],
  a: MdLink as Components['a'],
};

export const MarkdownView = memo(function MarkdownView({ source, className }: { source: string; className?: string }) {
  return (
    <div className={`md ${className ?? ''}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS as never}
        rehypePlugins={REHYPE_PLUGINS as never}
        components={COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
