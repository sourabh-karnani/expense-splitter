import type { ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import type { User } from './api';
import { useCurrentUser } from './auth';
import { LoginPage } from './pages/LoginPage';
import { NotesPage } from './pages/NotesPage';
import { GroupsPage } from './pages/GroupsPage';
import { GroupPage } from './pages/GroupPage';
import { ExpenseFormPage } from './pages/ExpenseFormPage';
import { JoinPage } from './pages/JoinPage';
import { SettleWithPage } from './pages/SettleWithPage';

// Only same-site paths: "/x" is fine, "//evil.com" and "/\evil.com" are protocol-relative (open redirect).
function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/';
  return next;
}

function Protected({ user, children }: { user: User | null | undefined; children: ReactNode }) {
  const location = useLocation();
  if (!user) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}

function LoginRoute({ user }: { user: User | null | undefined }) {
  const [params] = useSearchParams();
  if (user) return <Navigate to={safeNext(params.get('next'))} replace />;
  return <LoginPage />;
}

export function App() {
  const { data: user, isPending, error } = useCurrentUser();

  if (isPending) return <p className="center">Loading…</p>;
  if (error) return <p className="center error">Could not reach the API: {error.message}</p>;

  const guard = (el: (u: User) => ReactNode) => <Protected user={user}>{user && el(user)}</Protected>;

  return (
    <Routes>
      <Route path="/login" element={<LoginRoute user={user} />} />
      <Route path="/" element={guard((u) => <GroupsPage user={u} />)} />
      <Route path="/notes" element={guard((u) => <NotesPage user={u} />)} />
      <Route path="/groups/:gid" element={guard((u) => <GroupPage user={u} />)} />
      <Route path="/groups/:gid/expenses/new" element={guard(() => <ExpenseFormPage />)} />
      <Route path="/groups/:gid/expenses/:eid/edit" element={guard(() => <ExpenseFormPage />)} />
      <Route path="/j/:code" element={guard(() => <JoinPage />)} />
      <Route path="/settle/:userId" element={guard((u) => <SettleWithPage user={u} />)} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
