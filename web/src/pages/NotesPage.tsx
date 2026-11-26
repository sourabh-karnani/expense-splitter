import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type Note, type Page, type User } from '../api';

// Example page. Copy this pattern for new resources.
export function NotesPage({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');

  const notes = useInfiniteQuery({
    queryKey: ['notes'],
    queryFn: ({ pageParam }) =>
      api<Page<Note>>(`/notes?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const create = useMutation({
    mutationFn: () => api<{ note: Note }>('/notes', { method: 'POST', body: JSON.stringify({ title, body }) }),
    onSuccess: () => {
      setTitle('');
      setBody('');
      return queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api<void>(`/notes/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['notes'] }),
  });

  const logout = useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['notes'] });
      queryClient.setQueryData(['me'], null);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const items = notes.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <main className="card wide">
      <header className="row">
        <h1>Notes</h1>
        <span>
          {user.name} ·{' '}
          <button className="link" onClick={() => logout.mutate()}>
            Log out
          </button>
        </span>
      </header>

      <form onSubmit={submit}>
        <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
        <textarea placeholder="Body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
        {create.error && <p className="error">{create.error.message}</p>}
        <button disabled={create.isPending}>{create.isPending ? 'Saving…' : 'Add note'}</button>
      </form>

      {notes.isPending && <p>Loading notes…</p>}
      {notes.error && <p className="error">{notes.error.message}</p>}
      {notes.isSuccess && items.length === 0 && <p className="muted">No notes yet.</p>}

      <ul className="list">
        {items.map((n) => (
          <li key={n.id}>
            {/* React renders this as text, so user content can't inject HTML or scripts (XSS). */}
            <strong>{n.title}</strong>
            {n.body && <p>{n.body}</p>}
            <button className="link danger" onClick={() => remove.mutate(n.id)} disabled={remove.isPending}>
              Delete
            </button>
          </li>
        ))}
      </ul>

      {notes.hasNextPage && (
        <button onClick={() => notes.fetchNextPage()} disabled={notes.isFetchingNextPage}>
          {notes.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </main>
  );
}
