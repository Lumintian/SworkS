import { useEffect, useState } from 'react';
import type { SessionDTO } from '@shared/api';
import { ErrorBox, PageHeader, Spinner } from '../components/ui';
import { errorMessage, loadSession } from '../lib/api';
import { formatBytes, formatTime } from '../lib/format';

export function AboutPage() {
  const [s, setS] = useState<SessionDTO | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    loadSession(true).then(setS, (e) => setError(errorMessage(e)));
  }, []);
  if (error) return <ErrorBox message={error} />;
  if (!s) return <Spinner />;
  const rows: [string, string][] = [
    ['程序版本', s.appVersion],
    ['访问地址', s.address],
    ['数据目录', s.dataDir],
    ['数据库文件', `${s.dataDir}/db.sqlite3`],
    ['数据库 schema', `v${s.schemaVersion}`],
    ['库 ID', s.libraryId],
    ['最近一次成功备份', s.lastBackupAt ? formatTime(s.lastBackupAt) : '尚未备份'],
    ['单张图片上限', formatBytes(s.limits.maxImageBytes)],
    ['远程图片下载超时', `${Math.round(s.limits.remoteTimeoutMs / 1000)} 秒`],
    ['最多重定向次数', String(s.limits.maxRedirects)],
    ['fake-ip DNS 段（198.18.0.0/15）', s.limits.allowFakeIpDns ? '已允许（--allow-fake-ip-dns）' : '不允许（默认）'],
  ];
  return (
    <div className="space-y-5">
      <PageHeader title="数据目录与运行信息" subtitle="本机单用户运行，服务只绑定 127.0.0.1，无需登录。" />
      <dl className="card grid grid-cols-1 gap-x-6 gap-y-2 px-5 py-4 text-sm sm:grid-cols-[12rem_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-semibold text-ink-soft">{k}</dt>
            <dd className="break-all font-mono text-xs leading-6" data-testid={`about-${k}`}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="card-flat space-y-2 px-5 py-4 text-sm text-ink-soft">
        <p>
          图片支持 PNG、JPEG、WebP、GIF。远程图片只从公网 http/https 地址下载，会拒绝本机、内网等地址；以上限制为工程默认值。
        </p>
        <p>用户内容的权威副本在数据目录中；浏览器不保存唯一副本。搜索索引可随时重建。</p>
      </div>
    </div>
  );
}
