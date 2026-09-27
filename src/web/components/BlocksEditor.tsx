/**
 * 有序内容块编辑：Markdown / 普通文字 / 图片，手动追加、移除、调整顺序。
 * 题目与资料共用本组件。明确的收录区域支持粘贴截图/文字、拖入图片。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ClipboardPaste, FileText, ImagePlus, Link2, PencilLine, Trash2, Type, FileCode2, Eye } from 'lucide-react';
import type { AssetDTO, RemoteImageDTO } from '@shared/api';
import { assetUrl, errorMessage } from '../lib/api';
import { newBlock, type DraftBlock, type Refs } from '../lib/draft';
import { addRemoteImage, extFor, IMAGE_ACCEPT, importTextFile, isSingleUrl, manualRemoteImage, recordPastedText, retryRemoteImage, uploadImageFile } from '../lib/ingest';
import { formatBytes } from '../lib/format';
import { isEditableTarget } from '../lib/hotkeys';
import { MarkdownAssetsContext } from '../markdown/MarkdownView';
import { MarkdownField } from './MarkdownField';
import { useToast } from './ui';

export interface ContentIO {
  refs: Refs;
  addRefs: (r: Partial<Refs>) => void;
  updateRemote: (r: RemoteImageDTO) => void;
  addRawInput: (id: string) => void;
}

const KIND_LABEL = { markdown: 'Markdown', text: '文字（按原文显示）', image: '图片' } as const;

/** 上传图片并返回 Markdown 引用片段（供编辑器内粘贴图片使用）。 */
export function useMarkdownImageUpload(io: ContentIO) {
  const toast = useToast();
  return useCallback(
    async (files: File[]): Promise<string> => {
      const snippets: string[] = [];
      for (const f of files) {
        try {
          const r = await uploadImageFile(f);
          io.addRefs({ assets: { [r.asset.id]: r.asset } });
          io.addRawInput(r.rawInputId);
          snippets.push(`![](assets/${r.asset.id}.${extFor(r.asset.mime)})`);
        } catch (err) {
          toast(`图片未保存：${errorMessage(err)}`, 'error');
        }
      }
      return snippets.join('\n');
    },
    [io, toast],
  );
}

function ImageBlockView({
  block,
  asset,
  remote,
  onCaption,
  io,
}: {
  block: DraftBlock;
  asset: AssetDTO | undefined;
  remote: RemoteImageDTO | undefined;
  onCaption: (v: string) => void;
  io: ContentIO;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const localId = asset?.id ?? (remote?.status === 'archived' ? remote.assetId : null);
  return (
    <div className="space-y-2">
      {localId ? (
        <a href={assetUrl(localId)} target="_blank" rel="noopener noreferrer" title="在新标签页查看原图" className="inline-block max-w-full">
          <img className="source-image" src={assetUrl(localId)} alt={block.caption || '题目图片'} loading="lazy" />
        </a>
      ) : (
        <div className="md-img-placeholder md-img-placeholder--warn w-full">
          <span className="md-img-placeholder__title">
            {remote?.status === 'pending' ? '图片归档中…' : '图片尚未归档（原 URL 已记录）'}
          </span>
          {remote ? <span className="md-img-placeholder__url">{remote.url}</span> : null}
          {remote?.errorMessage ? <span className="md-img-placeholder__err">失败原因：{remote.errorMessage}</span> : null}
          {remote && remote.status !== 'pending' ? (
            <span className="md-img-placeholder__actions">
              <button
                type="button"
                className="link-btn"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const r = await retryRemoteImage(remote.id);
                    io.updateRemote(r);
                    if (r.status === 'archived') toast('图片已归档到本地', 'success');
                    else toast(`仍未归档：${r.errorMessage ?? ''}`, 'warn');
                  } catch (err) {
                    toast(errorMessage(err), 'error');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? '重试中…' : '重试下载'}
              </button>
              <label className="link-btn">
                手动补传
                <input
                  type="file"
                  accept={IMAGE_ACCEPT}
                  className="sr-only"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    try {
                      const r = await manualRemoteImage(remote.id, f);
                      io.updateRemote(r);
                      toast('已用本地图片补全', 'success');
                    } catch (err) {
                      toast(errorMessage(err), 'error');
                    }
                  }}
                />
              </label>
            </span>
          ) : null}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
        {asset ? <span>{asset.originalFilename ?? '粘贴的图片'} · {formatBytes(asset.size)}</span> : null}
        {remote ? (
          <span className={remote.status === 'archived' ? 'chip' : remote.status === 'failed' ? 'chip chip-warn' : 'chip chip-stone'}>
            {remote.status === 'archived' ? (remote.archivedVia === 'manual' ? '已手动补传' : '已归档') : remote.status === 'failed' ? '未归档' : '归档中'}
          </span>
        ) : null}
        {remote && remote.status === 'archived' ? <span className="truncate" title={remote.url}>来源 {remote.url}</span> : null}
      </div>
      <input className="input" value={block.caption} placeholder="图片说明（可选，参与搜索）" maxLength={2000} aria-label="图片说明" onChange={(e) => onCaption(e.target.value)} />
    </div>
  );
}

function TextBlockView({ block, onChange, onConvert, startInEdit }: { block: DraftBlock; onChange: (v: string) => void; onConvert: () => void; startInEdit: boolean }) {
  const [editing, setEditing] = useState(startInEdit);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 4, 640)}px`;
  }, [block.body, editing]);
  return (
    <div className="space-y-2">
      {editing ? (
        <textarea ref={ref} className="textarea min-h-[6rem]" value={block.body} autoFocus={startInEdit} aria-label="普通文字内容" onChange={(e) => onChange(e.target.value)} />
      ) : block.body ? (
        <p className="whitespace-pre-wrap break-words text-[0.97rem] leading-7">{block.body}</p>
      ) : (
        <p className="text-sm italic text-ink-faint">（空）</p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onConvert} title="把此块改为 Markdown，之后按 Markdown 语法渲染">
          <FileCode2 size={15} /> 转为 Markdown
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing((v) => !v)}>
          {editing ? <Eye size={15} /> : <PencilLine size={15} />} {editing ? '完成' : '编辑'}
        </button>
      </div>
    </div>
  );
}

export function BlocksEditor({
  blocks,
  onChange,
  io,
  captureGlobalPaste,
  selectable,
  selected,
  onToggleSelect,
  emptyHint,
}: {
  blocks: DraftBlock[];
  onChange: (update: (blocks: DraftBlock[]) => DraftBlock[]) => void;
  io: ContentIO;
  captureGlobalPaste?: boolean;
  selectable?: boolean;
  selected?: Set<string>;
  onToggleSelect?: (id: string) => void;
  emptyHint?: ReactNode;
}) {
  const toast = useToast();
  const [fresh] = useState(() => new Set<string>());
  const [urlOpen, setUrlOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLInputElement>(null);
  const uploadMd = useMarkdownImageUpload(io);

  const append = useCallback(
    (b: DraftBlock, focus = true) => {
      if (focus) fresh.add(b.id);
      onChange((bs) => [...bs, b]);
    },
    [fresh, onChange],
  );

  const addImages = useCallback(
    async (files: File[]) => {
      for (const f of files) {
        const blockId = crypto.randomUUID();
        setBusy('正在保存图片…');
        try {
          const r = await uploadImageFile(f, blockId);
          io.addRefs({ assets: { [r.asset.id]: r.asset } });
          io.addRawInput(r.rawInputId);
          append(newBlock('image', { id: blockId, assetId: r.asset.id }), false);
        } catch (err) {
          toast(`图片未保存：${errorMessage(err)}`, 'error');
        } finally {
          setBusy(null);
        }
      }
    },
    [append, io, toast],
  );

  const addRemote = useCallback(
    async (raw: string, fromPaste = false) => {
      const u = raw.trim();
      if (!u) return;
      const blockId = crypto.randomUUID();
      setBusy('正在下载图片…');
      try {
        const r = await addRemoteImage(u, blockId);
        io.updateRemote(r.remoteImage);
        if (r.asset) io.addRefs({ assets: { [r.asset.id]: r.asset } });
        io.addRawInput(r.rawInputId);
        if (fromPaste && r.remoteImage.status === 'failed' && r.remoteImage.errorCode === 'UNSUPPORTED_MEDIA') {
          // 粘贴的是网页链接而不是图片：按普通文字保留，不当作图片
          append(newBlock('text', { id: blockId, body: raw }), false);
          toast('这个链接不是图片，已按普通文字保留；如果是来源网页，可以移到“来源备注”。', 'info');
          return;
        }
        append(newBlock('image', { id: blockId, remoteImageId: r.remoteImage.id }), false);
        if (r.remoteImage.status === 'archived') toast('图片已下载并归档到本地', 'success');
        else toast(`已记录图片地址，但图片尚未归档：${r.remoteImage.errorMessage ?? ''}`, 'warn');
        setUrl('');
        setUrlOpen(false);
      } catch (err) {
        toast(errorMessage(err), 'error');
      } finally {
        setBusy(null);
      }
    },
    [append, io, toast],
  );

  const addPastedText = useCallback(
    async (text: string) => {
      const blockId = crypto.randomUUID();
      try {
        const r = await recordPastedText(text, blockId);
        io.addRawInput(r.rawInputId);
      } catch (err) {
        toast(`原始文本未能记录：${errorMessage(err)}`, 'warn');
      }
      append(newBlock('text', { id: blockId, body: text }), false);
    },
    [append, io, toast],
  );

  const handlePaste = useCallback(
    (e: ClipboardEvent | React.ClipboardEvent) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const files = Array.from(dt.files ?? []);
      const text = dt.getData('text/plain');
      if (files.length > 0) {
        e.preventDefault();
        void addImages(files);
      } else if (text) {
        e.preventDefault();
        if (isSingleUrl(text)) void addRemote(text, true);
        else void addPastedText(text);
      }
    },
    [addImages, addPastedText, addRemote],
  );

  // 焦点不在任何编辑器内时，页面上的粘贴进入本收录区
  useEffect(() => {
    if (!captureGlobalPaste) return;
    const onPaste = (e: ClipboardEvent) => {
      // 收录区自身已处理的粘贴不再重复处理
      if (e.defaultPrevented) return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      if (document.querySelector('dialog[open]')) return;
      handlePaste(e);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [captureGlobalPaste, handlePaste]);

  const move = (i: number, d: -1 | 1) =>
    onChange((bs) => {
      const j = i + d;
      if (j < 0 || j >= bs.length) return bs;
      const next = [...bs];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const update = (id: string, patch: Partial<DraftBlock>) => onChange((bs) => bs.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  const mdCtx = {
    remoteImageUrls: io.refs.remoteImageUrls,
    remoteImages: io.refs.remoteImages,
    onRetryRemote: async (id: string) => {
      try {
        io.updateRemote(await retryRemoteImage(id));
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
    onManualRemote: async (id: string, f: File) => {
      try {
        io.updateRemote(await manualRemoteImage(id, f));
      } catch (err) {
        toast(errorMessage(err), 'error');
      }
    },
  };

  return (
    <MarkdownAssetsContext.Provider value={mdCtx}>
      <div className="space-y-3">
        {blocks.length === 0 && emptyHint ? <div className="text-sm text-ink-soft">{emptyHint}</div> : null}
        <ol className="space-y-3" aria-label="内容块">
          {blocks.map((b, i) => (
            <li key={b.id} className="card-flat px-4 pb-4 pt-2.5" data-block-kind={b.kind} data-testid="content-block">
              <div className="mb-2 flex items-center gap-2">
                {selectable ? (
                  <input
                    type="checkbox"
                    className="h-4 w-4 accent-[var(--color-sage-deep)]"
                    aria-label={`选择第 ${i + 1} 块`}
                    checked={selected?.has(b.id) ?? false}
                    onChange={() => onToggleSelect?.(b.id)}
                  />
                ) : null}
                <span className="chip chip-stone">{KIND_LABEL[b.kind]}</span>
                <span className="text-xs text-ink-faint">第 {i + 1} 块</span>
                <div className="ml-auto flex items-center gap-1">
                  <button type="button" className="btn btn-ghost btn-icon" aria-label={`上移第 ${i + 1} 块`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp size={16} />
                  </button>
                  <button type="button" className="btn btn-ghost btn-icon" aria-label={`下移第 ${i + 1} 块`} disabled={i === blocks.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown size={16} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon hover:!text-terracotta"
                    aria-label={`移除第 ${i + 1} 块`}
                    onClick={() => onChange((bs) => bs.filter((x) => x.id !== b.id))}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
              {b.kind === 'markdown' ? (
                <MarkdownField
                  value={b.body}
                  onChange={(v) => update(b.id, { body: v })}
                  ariaLabel={`第 ${i + 1} 块 Markdown 源码`}
                  placeholder="Markdown 源码，支持 $公式$ 与 > [!tip] callout；可直接粘贴截图"
                  startInEdit={fresh.has(b.id) || !b.body}
                  onImageFiles={uploadMd}
                />
              ) : b.kind === 'text' ? (
                <TextBlockView block={b} startInEdit={fresh.has(b.id)} onChange={(v) => update(b.id, { body: v })} onConvert={() => update(b.id, { kind: 'markdown' })} />
              ) : (
                <ImageBlockView
                  block={b}
                  asset={b.assetId ? io.refs.assets[b.assetId] : undefined}
                  remote={b.remoteImageId ? io.refs.remoteImages[b.remoteImageId] : undefined}
                  onCaption={(v) => update(b.id, { caption: v })}
                  io={io}
                />
              )}
            </li>
          ))}
        </ol>

        <div
          className="paste-zone flex flex-col gap-3 px-4 py-3"
          tabIndex={0}
          role="region"
          aria-label="收录区：在此粘贴截图或文字，或拖入图片"
          data-active={dragOver}
          data-testid="paste-zone"
          onPaste={(e) => {
            if (isEditableTarget(e.target)) return;
            handlePaste(e);
          }}
          onDragOver={(e) => {
            if (Array.from(e.dataTransfer.items).some((it) => it.kind === 'file')) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            setDragOver(false);
            const files = Array.from(e.dataTransfer.files);
            if (files.length) {
              e.preventDefault();
              void addImages(files);
            }
          }}
        >
          <div className="flex items-center gap-2 text-sm">
            <ClipboardPaste size={17} className="text-sage-deep" />
            <span>
              点击此处后按 <kbd className="rounded bg-surface px-1.5 font-mono text-xs">Ctrl</kbd>+<kbd className="rounded bg-surface px-1.5 font-mono text-xs">V</kbd>{' '}
              粘贴截图或文字，或把图片拖到这里。{busy ? <strong className="ml-2 text-sage-deep">{busy}</strong> : null}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm" onClick={() => append(newBlock('markdown'))}>
              <FileText size={15} /> Markdown
            </button>
            <button type="button" className="btn btn-sm" onClick={() => append(newBlock('text'))}>
              <Type size={15} /> 普通文字
            </button>
            <button type="button" className="btn btn-sm" onClick={() => imageInput.current?.click()}>
              <ImagePlus size={15} /> 图片
            </button>
            <button type="button" className="btn btn-sm" aria-expanded={urlOpen} onClick={() => setUrlOpen((v) => !v)}>
              <Link2 size={15} /> 图片 URL
            </button>
            <button type="button" className="btn btn-sm" onClick={() => textInput.current?.click()}>
              <FileCode2 size={15} /> 导入 .md / .txt
            </button>
            <input
              ref={imageInput}
              type="file"
              accept={IMAGE_ACCEPT}
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              data-testid="image-file-input"
              onChange={(e) => {
                const f = Array.from(e.target.files ?? []);
                e.target.value = '';
                void addImages(f);
              }}
            />
            <input
              ref={textInput}
              type="file"
              accept=".md,.markdown,.txt,text/markdown,text/plain"
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                const blockId = crypto.randomUUID();
                try {
                  const r = await importTextFile(f, blockId);
                  io.addRawInput(r.rawInputId);
                  append(newBlock(r.kind, { id: blockId, body: r.text }), false);
                  if (r.missingLocalImages.length) {
                    toast(`导入完成，但有 ${r.missingLocalImages.length} 张本地图片无法读取，请在块中手动补传：${r.missingLocalImages.join('、')}`, 'warn');
                  } else toast(`已导入 ${f.name}`, 'success');
                } catch (err) {
                  toast(`导入失败：${errorMessage(err)}`, 'error');
                }
              }}
            />
          </div>
          {urlOpen ? (
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void addRemote(url);
              }}
            >
              <input
                className="input flex-1"
                type="url"
                inputMode="url"
                placeholder="https://… 图片地址（将下载并归档到本地）"
                value={url}
                autoFocus
                aria-label="图片 URL"
                onChange={(e) => setUrl(e.target.value)}
              />
              <button type="submit" className="btn btn-sage btn-sm" disabled={!url.trim() || busy !== null}>
                下载并添加
              </button>
            </form>
          ) : null}
        </div>
      </div>
    </MarkdownAssetsContext.Provider>
  );
}
