/** 设置：图片存储（收录时的格式转换，保存在库里、随备份）；MCP 接入（保存在数据目录的 mcp.json，不进备份）。 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Check, Copy, KeyRound } from 'lucide-react';
import type { ImagePolicyDTO, McpStatusDTO } from '@shared/api';
import { ErrorBox, PageHeader, Spinner, useConfirm, useToast } from '../components/ui';
import { errorMessage, getJSON, sendJSON } from '../lib/api';
import { queryClient } from '../lib/queryClient';

const EDGE_CHOICES = [0, 2048, 3072, 4096];

function ImagePolicySection() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings', 'images'], queryFn: () => getJSON<ImagePolicyDTO>('/api/settings/images') });
  const [draft, setDraft] = useState<ImagePolicyDTO | null>(null);
  useEffect(() => {
    if (q.data) setDraft(q.data);
  }, [q.data]);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorBox message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (!draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data);
  const save = async () => {
    try {
      const saved = await sendJSON<ImagePolicyDTO>('PUT', '/api/settings/images', draft);
      queryClient.setQueryData(['settings', 'images'], saved);
      toast('图片设置已保存', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };
  const check = (key: 'enabled' | 'pngLossless', label: string, hint: string) => (
    <label className="flex items-start gap-2">
      <input type="checkbox" className="mt-1 accent-[var(--color-sage-deep)]" checked={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })} />
      <span>
        <span className="font-semibold text-stone">{label}</span>
        <span className="block text-xs text-ink-faint">{hint}</span>
      </span>
    </label>
  );
  return (
    <section className="card-flat space-y-4 px-5 py-4 text-sm" aria-label="图片存储">
      <h2 className="text-lg font-semibold text-stone">图片存储</h2>
      <p className="text-ink-soft">
        只影响之后新收录的图片，已有附件不动。转换后只保存转换结果；原始输入记录里保留原文件的格式、大小与哈希。iPhone 的 HEIC/HEIF 与 AVIF 无论开关都会转换成 WebP（浏览器无法直接显示）。
        转换后的图片去掉拍摄位置等元数据，只保留色彩配置，不改颜色。远程图片按原样保存。
      </p>
      {check('enabled', '转换新收录的图片以节省空间', '关闭后 PNG、JPEG 按原样保存。')}
      <fieldset className={`space-y-3 pl-6 ${draft.enabled ? '' : 'opacity-50'}`} disabled={!draft.enabled}>
        {check('pngLossless', '截图（PNG）转为无损 WebP', '逐像素相同，通常小一半左右；更小时才采用。16 位、动画 PNG 保持原样。')}
        <label className="flex flex-wrap items-center gap-2">
          <span className="w-36 text-ink-soft">照片质量</span>
          <input
            type="range"
            className="accent-[var(--color-sage-deep)]"
            min={60}
            max={95}
            step={5}
            value={draft.photoQuality}
            aria-label="照片质量"
            onChange={(e) => setDraft({ ...draft, photoQuality: Number(e.target.value) })}
          />
          <span className="font-mono text-xs">{draft.photoQuality}</span>
          <span className="text-xs text-ink-faint">JPEG、HEIC、AVIF 照片转为有损 WebP 的质量（默认 85）</span>
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <span className="w-36 text-ink-soft">照片长边上限</span>
          <select className="select w-auto py-1" value={draft.maxLongEdge} aria-label="照片长边上限" onChange={(e) => setDraft({ ...draft, maxLongEdge: Number(e.target.value) })}>
            {EDGE_CHOICES.map((n) => (
              <option key={n} value={n}>
                {n === 0 ? '不限' : `${n} 像素`}
              </option>
            ))}
          </select>
          <span className="text-xs text-ink-faint">更大的照片按比例缩小；截图不缩放</span>
        </label>
        <label className="flex flex-wrap items-center gap-2">
          <span className="w-36 text-ink-soft">JPEG 至少节省</span>
          <select className="select w-auto py-1" value={draft.minSaving} aria-label="JPEG 至少节省" onChange={(e) => setDraft({ ...draft, minSaving: Number(e.target.value) })}>
            {[0, 0.1, 0.2, 0.3].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? '总是转换' : `${Math.round(n * 100)}%`}
              </option>
            ))}
          </select>
          <span className="text-xs text-ink-faint">节省不到这个比例时保留原 JPEG</span>
        </label>
      </fieldset>
      <div className="flex gap-2">
        <button type="button" className="btn btn-sage" disabled={!dirty} onClick={() => void save()}>
          保存
        </button>
        {dirty ? (
          <button type="button" className="btn btn-ghost" onClick={() => setDraft(q.data)}>
            还原
          </button>
        ) : null}
      </div>
    </section>
  );
}

function CopyBlock({ label, text, testId }: { label: string; text: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-ink-soft">
        <span>{label}</span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1500);
              },
              () => undefined,
            );
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded bg-sunken p-2 font-mono text-xs" data-testid={testId}>
        {text}
      </pre>
    </div>
  );
}

function McpSection() {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ['settings', 'mcp'], queryFn: () => getJSON<McpStatusDTO>('/api/mcp') });
  // 页面上显示的状态：开关在事件里同步更新（受控的复选框需要），服务端确认后以返回值为准
  const [local, setLocal] = useState<McpStatusDTO | null>(null);
  useEffect(() => {
    if (q.data) setLocal(q.data);
  }, [q.data]);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorBox message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const s = local ?? q.data;
  const update = async (body: { enabled?: boolean; mode?: 'read' | 'write'; regenerateToken?: boolean }, ok: string) => {
    const before = s;
    const { regenerateToken: _, ...visible } = body;
    setLocal({ ...s, ...visible });
    try {
      queryClient.setQueryData(['settings', 'mcp'], await sendJSON<McpStatusDTO>('POST', '/api/mcp', body));
      toast(ok, 'success');
    } catch (err) {
      setLocal(before);
      toast(errorMessage(err), 'error');
    }
  };
  return (
    <section className="card-flat space-y-4 px-5 py-4 text-sm" aria-label="MCP">
      <h2 className="text-lg font-semibold text-stone">MCP（让 AI 助手使用题库）</h2>
      <p className="text-ink-soft">
        启用后，本机的 MCP 客户端（例如 Claude Code）可以检索题目、查看题图，并在可写模式下写解析、打标签、设置题型与考点。
        只接受本机的命令行客户端（带令牌），网页无法调用；AI 的修改会立即出现在打开着的页面上，也会像其他修改一样记录版本。令牌保存在数据目录的 mcp.json 里，不进备份。
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          className="accent-[var(--color-sage-deep)]"
          checked={s.enabled}
          aria-label="启用 MCP"
          onChange={(e) => void update({ enabled: e.target.checked }, e.target.checked ? '已启用 MCP' : '已关闭 MCP')}
        />
        <span className="font-semibold text-stone">启用 MCP</span>
      </label>
      {s.enabled ? (
        <>
          <fieldset className="flex flex-wrap items-center gap-4">
            <legend className="sr-only">权限</legend>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="mcp-mode" className="accent-[var(--color-sage-deep)]" checked={s.mode === 'read'} onChange={() => void update({ mode: 'read' }, '已改为只读')} />
              只读（检索、读取）
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" name="mcp-mode" className="accent-[var(--color-sage-deep)]" checked={s.mode === 'write'} onChange={() => void update({ mode: 'write' }, '已允许写入')} />
              可写（也能新建题目、写笔记、改属性、移到回收站）
            </label>
          </fieldset>
          <CopyBlock label="Claude Code：在终端运行" text={s.claudeCommand} testId="mcp-claude-command" />
          <CopyBlock label="只支持 stdio 的客户端：加入它的 MCP 配置（需要本服务在运行）" text={s.stdioConfig} testId="mcp-stdio-config" />
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
            <span>地址 {s.url}</span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={async () => {
                if (await confirm({ title: '重新生成令牌', message: '已配置的客户端需要换成新令牌才能继续使用。', confirmLabel: '重新生成' })) {
                  void update({ regenerateToken: true }, '已生成新令牌');
                }
              }}
            >
              <KeyRound size={13} /> 重新生成令牌
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function SettingsPage() {
  return (
    <div className="space-y-5">
      <PageHeader title="设置" subtitle="图片设置保存在资料库里（随备份）；MCP 设置只属于这台电脑上的这个数据目录。" />
      <ImagePolicySection />
      <McpSection />
    </div>
  );
}
