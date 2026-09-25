/** 极简前端路由：History API + 未保存修改的离开确认。 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';

type Guard = () => boolean;
const guards = new Set<Guard>();
const LEAVE_MESSAGE = '当前页面有未保存的修改，确定离开吗？离开后这些修改会丢失。';

function allowLeave(): boolean {
  for (const g of guards) {
    if (g() && !window.confirm(LEAVE_MESSAGE)) return false;
  }
  return true;
}

interface RouterState {
  path: string;
  search: string;
  navigate: (to: string, opts?: { replace?: boolean; force?: boolean }) => void;
}

const RouterContext = createContext<RouterState | null>(null);

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState(() => ({ path: window.location.pathname, search: window.location.search }));
  const current = useRef(window.location.pathname + window.location.search);

  useEffect(() => {
    const onPop = () => {
      const next = window.location.pathname + window.location.search;
      if (!allowLeave()) {
        window.history.pushState(null, '', current.current);
        return;
      }
      current.current = next;
      setLoc({ path: window.location.pathname, search: window.location.search });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback<RouterState['navigate']>((to, opts) => {
    if (!opts?.force && !allowLeave()) return;
    if (opts?.replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    current.current = to;
    const u = new URL(to, window.location.origin);
    setLoc({ path: u.pathname, search: u.search });
    if (!opts?.replace) window.scrollTo(0, 0);
  }, []);

  return <RouterContext.Provider value={{ ...loc, navigate }}>{children}</RouterContext.Provider>;
}

export function useRouter(): RouterState {
  const r = useContext(RouterContext);
  if (!r) throw new Error('RouterProvider missing');
  return r;
}

/** 注册“有未保存修改”判定；同时处理关闭/刷新页面。 */
export function useLeaveGuard(isDirty: () => boolean): void {
  const ref = useRef(isDirty);
  ref.current = isDirty;
  useEffect(() => {
    const guard: Guard = () => ref.current();
    guards.add(guard);
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (ref.current()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      guards.delete(guard);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);
}

export function Link({ to, children, ...rest }: { to: string; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      {...rest}
      onClick={(e) => {
        rest.onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) params[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return params;
}
