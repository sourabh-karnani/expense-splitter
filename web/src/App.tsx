import { Navigate, Route, Routes } from 'react-router-dom';
import { useCurrentUser } from './auth';
import { LoginPage } from './pages/LoginPage';
import { NotesPage } from './pages/NotesPage';

export function App() {
  const { data: user, isPending, error } = useCurrentUser();

  if (isPending) return <p className="center">Loading…</p>;
  if (error) return <p className="center error">Could not reach the API: {error.message}</p>;

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/" element={user ? <NotesPage user={user} /> : <Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
