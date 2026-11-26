import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type User } from '../api';

export function LoginPage() {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ name: '', email: '', password: '' });

  const auth = useMutation({
    mutationFn: () =>
      api<{ user: User }>(`/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify(mode === 'login' ? { email: form.email, password: form.password } : form),
      }),
    onSuccess: ({ user }) => queryClient.setQueryData(['me'], user),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    auth.mutate();
  }

  function switchMode() {
    setMode(mode === 'login' ? 'register' : 'login');
    auth.reset();
  }

  return (
    <main className="card">
      <h1>{mode === 'login' ? 'Log in' : 'Create account'}</h1>
      <form onSubmit={submit}>
        {mode === 'register' && (
          <input
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            maxLength={80}
          />
        )}
        <input
          type="email"
          placeholder="Email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          required
        />
        <input
          type="password"
          placeholder={mode === 'register' ? 'Password (8+ characters)' : 'Password'}
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
          required
          minLength={mode === 'register' ? 8 : undefined}
        />
        {auth.error && <p className="error">{auth.error.message}</p>}
        <button disabled={auth.isPending}>
          {auth.isPending ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Sign up'}
        </button>
      </form>
      <button className="link" onClick={switchMode}>
        {mode === 'login' ? 'No account? Sign up' : 'Have an account? Log in'}
      </button>
    </main>
  );
}
