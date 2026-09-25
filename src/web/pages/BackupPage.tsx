import { useCallback, useEffect, useState } from 'react';
import { Archive, Download, TriangleAlert } from 'lucide-react';
import type { BackupInfoDTO, BackupResultDTO } from '@shared/api';
import { ErrorBox, PageHeader, Spinner, useToast } from '../components/ui';
import { errorMessage, getJSON, loadSession, sendJSON } from '../lib/api';
import { daysSince, formatBytes, formatTime } from '../lib/format';
import { Link } from '../lib/router';

export function BackupPage() {
  const toast = useToast();
  const [list, setList] = useState<{ backups: BackupInfoDTO[]; lastBackupAt: string | null } | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BackupResultDTO | null>(null);
  const [dataDir, setDataDir] = useState('');

  const load = useCallback(() => {
    getJSON<{ backups: BackupInfoDTO[]; lastBackupAt: string | null }>('/api/backups').then(setList, (e) => setError(errorMessage(e)));
  }, []);
  useEffect(() => {
    load();
    loadSession().then((s) => setDataDir(s.dataDir), () => undefined);
  }, [load]);

  const days = daysSince(list?.lastBackupAt);
  return (
    <div className="space-y-6">
      <PageHeader title="备份与导出" subtitle="完整备份用于恢复与迁移；Markdown 导出用于脱离 SworkS 阅读，两者不能互相替代。" />

      <section className="card space-y-4 px-5 py-5">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="flex-1 text-lg font-semibold text-stone">完整备份</h2>
          <button
            type="button"
            className="btn btn-primary"
            disabled={running}
            data-testid="create-backup"
            onClick={async () => {
              setRunning(true);
              setResult(null);
              try {
                const r = await sendJSON<BackupResultDTO>('POST', '/api/backups');
                setResult(r);
                toast('备份已生成并通过校验', 'success');
                load();
              } catch (err) {
                toast(`备份失败：${errorMessage(err)}`, 'error');
              } finally {
                setRunning(false);
              }
            }}
          >
            <Archive size={16} /> {running ? '正在生成并校验…' : '生成完整备份'}
          </button>
        </div>
        <p className="text-sm text-ink-soft">
          包含全部题目、资料、内容块、笔记、标签、来源关系、原始输入、回收站记录与原始图片。备份默认含个人笔记和来源 URL，不是公开分享包。
        </p>
        <p className="text-sm">
          最近一次成功备份：<strong data-testid="last-backup">{list?.lastBackupAt ? formatTime(list.lastBackupAt) : '尚未备份'}</strong>
          {days !== null && days >= 7 ? <span className="chip chip-warn ml-2">已超过 {days} 天</span> : null}
        </p>
        <p className="flex items-start gap-2 text-sm text-ochre">
          <TriangleAlert size={16} className="mt-0.5 flex-none" />
          备份文件保存在数据目录的 backups/ 中。请把它另存到其他磁盘或位置，避免与数据一同丢失。
        </p>
        {result ? (
          <div className="card-flat space-y-1 bg-sage-soft px-4 py-3 text-sm" data-testid="backup-result">
            <p className="font-semibold text-sage-deep">本地数据备份完整：{result.fileName}（{formatBytes(result.size)}）</p>
            <p>
              题目 {result.counts.problems ?? 0}，资料 {result.counts.materials ?? 0}，笔记 {result.counts.notes ?? 0}，附件文件 {result.assetFiles}
            </p>
            {result.unarchivedRemoteImages.length > 0 ? (
              <p className="text-ochre">
                外部图片未全部归档：{result.unarchivedRemoteImages.length} 张远程图片只保存了 URL，离线时无法显示，也无法通过备份补回。
              </p>
            ) : (
              <p>外部图片：全部已归档。</p>
            )}
            <a className="link-btn" href={`/api/backups/${encodeURIComponent(result.fileName)}`} download>
              下载这份备份
            </a>
          </div>
        ) : null}
        {error ? <ErrorBox message={error} onRetry={load} /> : null}
        {!list && !error ? <Spinner /> : null}
        {list && list.backups.length > 0 ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-ink-soft">已有备份</h3>
            <ul className="divide-y divide-line text-sm">
              {list.backups.map((b) => (
                <li key={b.fileName} className="flex flex-wrap items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{b.fileName}</span>
                  <span className="text-xs text-ink-faint">{formatBytes(b.size)}</span>
                  <a className="btn btn-sm" href={`/api/backups/${encodeURIComponent(b.fileName)}`} download>
                    <Download size={14} /> 下载
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="card space-y-3 px-5 py-5">
        <h2 className="text-lg font-semibold text-stone">从备份恢复</h2>
        <p className="text-sm text-ink-soft">恢复在命令行中完成，且只能恢复到一个新的空目录；恢复过程先在临时目录校验，全部通过后才会发布，不会改动现有数据。</p>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>在终端按 Ctrl+C 停止当前 SworkS 服务。</li>
          <li>
            运行：
            <pre className="mt-1 overflow-x-auto rounded-lg bg-sunken px-3 py-2 font-mono text-xs">
              pnpm restore -- --input ./SworkS-backup-XXXX.sworks.zip --data-dir ./sworks-restored
            </pre>
          </li>
          <li>
            用恢复出的目录启动：<code className="rounded bg-sunken px-1 font-mono text-xs">pnpm start -- --data-dir ./sworks-restored</code>
          </li>
        </ol>
        {dataDir ? <p className="text-xs text-ink-faint">当前数据目录：{dataDir}</p> : null}
      </section>

      <section className="card space-y-2 px-5 py-5">
        <h2 className="text-lg font-semibold text-stone">Markdown 导出</h2>
        <p className="text-sm text-ink-soft">
          在 <Link to="/problems" className="link-btn">题目列表</Link> 中勾选题目后导出，或在题目页点击“导出”。每道题生成一个 Markdown 文件，图片放在 assets/ 目录并使用相对路径；公式与 callout 保留源码。只打包所选题目实际引用的资源。
        </p>
      </section>
    </div>
  );
}
