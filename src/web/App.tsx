import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect } from 'react';
import { MATERIAL_STATUSES, type MaterialStatus } from '@shared/constants';
import { isUuid } from '@shared/assetRef';
import { Layout } from './components/Layout';
import { ConfirmProvider, EmptyState, ToastProvider } from './components/ui';
import { newId } from './lib/format';
import { queryClient } from './lib/queryClient';
import { matchPath, RouterProvider, useRouter } from './lib/router';
import { AboutPage } from './pages/AboutPage';
import { BackupPage } from './pages/BackupPage';
import { InboxPage, MaterialsPage, ProblemsPage } from './pages/ListPages';
import { ManagePage } from './pages/ManagePage';
import { MaterialEditorPage } from './pages/MaterialEditorPage';
import { StudentPage, StudentsPage } from './pages/StudentPages';
import { ProblemEditorPage } from './pages/ProblemEditorPage';
import { TrashPage } from './pages/TrashPage';

function Routes() {
  const { path, search, navigate } = useRouter();
  const params = new URLSearchParams(search);
  const newIdParam = params.get('id');
  const isNewRoute = path === '/problems/new' || path === '/materials/new';

  // 新建页的 ID 放在 URL 里：刷新或重试不会产生第二条记录
  useEffect(() => {
    if (isNewRoute && !(newIdParam && isUuid(newIdParam))) {
      navigate(`${path}?id=${newId()}`, { replace: true, force: true });
    }
  }, [isNewRoute, newIdParam, navigate, path]);

  if (path === '/' || path === '/problems') return <ProblemsPage />;
  if (path === '/materials') return <MaterialsPage />;
  if (path === '/inbox') return <InboxPage />;
  if (path === '/trash') return <TrashPage />;
  if (path === '/backup') return <BackupPage />;
  if (path === '/about') return <AboutPage />;
  if (path === '/manage') return <ManagePage />;
  if (path === '/students') return <StudentsPage />;
  if (isNewRoute) {
    if (!newIdParam || !isUuid(newIdParam)) return null;
    const status = params.get('status');
    return path === '/problems/new' ? (
      <ProblemEditorPage key={newIdParam} id={newIdParam} isNew />
    ) : (
      <MaterialEditorPage
        key={newIdParam}
        id={newIdParam}
        isNew
        initialStatus={MATERIAL_STATUSES.includes(status as MaterialStatus) ? (status as MaterialStatus) : 'active'}
      />
    );
  }
  const p = matchPath('/problems/:id', path);
  if (p && isUuid(p.id!)) return <ProblemEditorPage key={p.id} id={p.id!} isNew={false} />;
  const st = matchPath('/students/:id', path);
  if (st && isUuid(st.id!)) return <StudentPage key={st.id} id={st.id!} />;
  const m = matchPath('/materials/:id', path);
  if (m && isUuid(m.id!)) return <MaterialEditorPage key={m.id} id={m.id!} isNew={false} initialStatus="active" />;
  return <EmptyState title="页面不存在">请从左侧导航进入。</EmptyState>;
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider>
        <ToastProvider>
          <ConfirmProvider>
            <Layout>
              <Routes />
            </Layout>
          </ConfirmProvider>
        </ToastProvider>
      </RouterProvider>
    </QueryClientProvider>
  );
}
