import { useEffect, useState, type ReactNode } from 'react';
import { Archive, BookOpen, FilePlus2, Inbox, Info, Library, Plus, Trash2 } from 'lucide-react';
import { getJSON, loadSession } from '../lib/api';
import { daysSince, newId } from '../lib/format';
import { Link, useRouter } from '../lib/router';

function NavItem({ to, icon, children, match }: { to: string; icon: ReactNode; children: ReactNode; match: (p: string) => boolean }) {
  const { path } = useRouter();
  return (
    <Link to={to} className="nav-item" aria-current={match(path) ? 'page' : undefined}>
      {icon}
      {children}
    </Link>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { navigate, path } = useRouter();
  const [lastBackup, setLastBackup] = useState<string | null | undefined>(undefined);
  const [inboxCount, setInboxCount] = useState<number | null>(null);
  useEffect(() => {
    loadSession(true).then((s) => setLastBackup(s.lastBackupAt), () => setLastBackup(undefined));
    getJSON<{ total: number }>('/api/materials?status=inbox&limit=1').then((r) => setInboxCount(r.total), () => undefined);
  }, [path]);
  const days = daysSince(lastBackup);

  return (
    <div className="min-h-screen md:grid md:grid-cols-[15.5rem_1fr]">
      <aside className="flex flex-col gap-5 border-b border-line px-4 py-4 md:sticky md:top-0 md:h-screen md:border-b-0 md:border-r md:py-6">
        <Link to="/problems" className="flex items-baseline gap-2 px-2">
          <span className="font-serif text-2xl font-bold text-stone">SworkS</span>
          <span className="text-xs text-ink-faint">题目工作台</span>
        </Link>
        <div className="flex gap-2 md:flex-col">
          <button type="button" className="btn btn-primary flex-1 justify-start" onClick={() => navigate(`/problems/new?id=${newId()}`)} data-testid="new-problem">
            <Plus size={17} /> 收一道题
          </button>
          <button type="button" className="btn flex-1 justify-start" onClick={() => navigate(`/materials/new?id=${newId()}`)} data-testid="new-material">
            <FilePlus2 size={17} /> 收一份资料
          </button>
        </div>
        <nav aria-label="主导航" className="flex flex-wrap gap-1 md:flex-col">
          <NavItem to="/problems" icon={<BookOpen size={17} />} match={(p) => p === '/' || p.startsWith('/problems')}>
            题目
          </NavItem>
          <NavItem to="/materials" icon={<Library size={17} />} match={(p) => p.startsWith('/materials')}>
            资料
          </NavItem>
          <NavItem to="/inbox" icon={<Inbox size={17} />} match={(p) => p.startsWith('/inbox')}>
            收件箱
            {inboxCount ? <span className="chip chip-warn ml-auto px-2 py-0 text-xs">{inboxCount}</span> : null}
          </NavItem>
        </nav>
        <nav aria-label="辅助入口" className="flex flex-wrap gap-1 border-t border-line pt-4 md:flex-col">
          <NavItem to="/trash" icon={<Trash2 size={16} />} match={(p) => p.startsWith('/trash')}>
            回收站
          </NavItem>
          <NavItem to="/backup" icon={<Archive size={16} />} match={(p) => p.startsWith('/backup')}>
            备份与导出
          </NavItem>
          <NavItem to="/about" icon={<Info size={16} />} match={(p) => p.startsWith('/about')}>
            数据目录与运行信息
          </NavItem>
        </nav>
        <div className="mt-auto hidden px-2 text-xs leading-5 text-ink-faint md:block">
          {lastBackup === null ? (
            <span className="text-ochre">尚未做过完整备份</span>
          ) : days !== null ? (
            <span className={days >= 7 ? 'text-ochre' : ''}>最近备份：{days === 0 ? '今天' : `${days} 天前`}</span>
          ) : null}
        </div>
      </aside>
      <main className="min-w-0 px-4 pb-16 pt-4 md:px-8 md:pt-6">
        <div className="mx-auto max-w-[1180px]">{children}</div>
      </main>
    </div>
  );
}
