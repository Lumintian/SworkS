import { useEffect, useState } from 'react';
import { Link2, Unlink } from 'lucide-react';
import type { ListResponse, RawInputDTO } from '@shared/api';
import { assetUrl, errorMessage, getJSON } from '../lib/api';
import type { DraftSource } from '../lib/draft';
import { formatTime } from '../lib/format';
import { Link } from '../lib/router';
import { Dialog, useToast } from './ui';

export function ConflictDialog({
  open,
  message,
  noun,
  onReload,
  onSaveAsNew,
  onCopy,
  onClose,
}: {
  open: boolean;
  message: string;
  noun: string;
  onReload: () => void;
  onSaveAsNew: () => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="保存冲突"
      footer={
        <>
          <button type="button" className="btn" onClick={onCopy}>
            复制本页内容
          </button>
          <button type="button" className="btn" onClick={onSaveAsNew}>
            另存为新{noun}
          </button>
          <button type="button" className="btn btn-danger" onClick={onReload}>
            重新加载（放弃本页修改）
          </button>
        </>
      }
    >
      <p className="text-sm leading-7">
        {message}。为避免覆盖别处的修改，本次没有保存。你当前页面上的内容仍然保留，可以先复制，或另存为一个新的{noun}，也可以重新加载最新版本。
      </p>
    </Dialog>
  );
}

export function SourcesEditor({ sources, onChange }: { sources: DraftSource[]; onChange: (u: (s: DraftSource[]) => DraftSource[]) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [items, setItems] = useState<ListResponse['items']>([]);
  const toast = useToast();
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      getJSON<ListResponse>(`/api/materials?limit=30&q=${encodeURIComponent(q)}`)
        .then((r) => setItems(r.items))
        .catch((err) => toast(errorMessage(err), 'error'));
    }, 200);
    return () => window.clearTimeout(t);
  }, [open, q, toast]);
  return (
    <div className="space-y-2">
      {sources.length === 0 ? <p className="text-sm text-ink-soft">未关联资料。直接收录的题目不需要来源资料。</p> : null}
      <ul className="space-y-2">
        {sources.map((s) => (
          <li key={s.materialId} className="flex flex-wrap items-center gap-2">
            <Link to={`/materials/${s.materialId}`} className="link-btn text-sm">
              {s.materialTitle ?? '未命名资料'}
            </Link>
            {s.materialDeleted ? <span className="chip chip-warn">资料在回收站</span> : null}
            <input
              className="input max-w-sm flex-1 py-1 text-sm"
              value={s.note}
              placeholder="来源说明（如页码、题号）"
              aria-label="来源说明"
              onChange={(e) => onChange((xs) => xs.map((x) => (x.materialId === s.materialId ? { ...x, note: e.target.value } : x)))}
            />
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange((xs) => xs.filter((x) => x.materialId !== s.materialId))}>
              <Unlink size={14} /> 取消关联
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        <Link2 size={15} /> 关联资料
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} title="关联来源资料" wide>
        <input className="input mb-3" placeholder="搜索资料…" value={q} autoFocus onChange={(e) => setQ(e.target.value)} aria-label="搜索资料" />
        <ul className="divide-y divide-line">
          {items.map((m) => {
            const linked = sources.some((s) => s.materialId === m.id);
            return (
              <li key={m.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className={`truncate font-semibold ${m.title ? 'text-stone' : 'italic text-ink-faint'}`}>{m.title ?? '未命名资料'}</p>
                  <p className="truncate text-xs text-ink-soft">{m.summary || '（无文字内容）'}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-sage"
                  disabled={linked}
                  onClick={() => {
                    onChange((xs) => [...xs, { materialId: m.id, materialTitle: m.title, materialDeleted: false, note: '' }]);
                    setOpen(false);
                  }}
                >
                  {linked ? '已关联' : '关联'}
                </button>
              </li>
            );
          })}
          {items.length === 0 ? <li className="py-4 text-sm text-ink-soft">没有匹配的资料。</li> : null}
        </ul>
      </Dialog>
    </div>
  );
}

const RAW_KIND: Record<RawInputDTO['kind'], string> = { text: '粘贴文字', file: '文件', url: '图片 URL' };

/** 原始输入留存（只读）：收到的原文、原文件、原 URL 与采集时间。 */
export function RawInputsPanel({ items }: { items: RawInputDTO[] }) {
  if (items.length === 0) return null;
  return (
    <details className="card-flat px-4 py-3 text-sm">
      <summary className="cursor-pointer font-semibold text-ink-soft">原始输入记录（{items.length}）</summary>
      <p className="mt-2 text-xs text-ink-faint">这里保存最初收到的内容，编辑题干不会改变它们。</p>
      <ul className="mt-2 space-y-2">
        {items.map((r) => (
          <li key={r.id} className="border-t border-line pt-2">
            <div className="flex flex-wrap gap-2 text-xs text-ink-soft">
              <span className="chip chip-stone">{RAW_KIND[r.kind]}</span>
              <span>{formatTime(r.capturedAt)}</span>
              {r.originalFilename ? <span>{r.originalFilename}</span> : null}
            </div>
            {r.url ? <p className="mt-1 break-all font-mono text-xs">{r.url}</p> : null}
            {r.kind === 'text' && r.text ? <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-sunken p-2 text-xs">{r.text}</pre> : null}
            {r.assetId ? (
              <a className="link-btn text-xs" href={assetUrl(r.assetId)} target="_blank" rel="noopener noreferrer">
                查看原文件
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </details>
  );
}
