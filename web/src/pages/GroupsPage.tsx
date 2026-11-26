import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type Group, type GroupDetail, type Page, type Settlement, type User } from '../api';
import { formatINR } from '../money';

// Query keys used across the expense pages:
// ['groups'], ['group', gid], ['group', gid, 'balances' | 'expenses' | 'settlements'],
// ['group', gid, 'expenses', eid], ['group', gid, 'expenses', eid, 'history'],
// ['pending-settlements'], ['settle-with', userId], ['join', code].

export function GroupsPage({ user }: { user: User }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');

  const groups = useInfiniteQuery({
    queryKey: ['groups'],
    queryFn: ({ pageParam }) =>
      api<Page<Group>>(`/groups?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const create = useMutation({
    mutationFn: () => api<GroupDetail>('/groups', { method: 'POST', body: JSON.stringify({ name }) }),
    onSuccess: (detail) => {
      setName('');
      queryClient.setQueryData(['group', detail.group.id], detail);
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
      navigate(`/groups/${encodeURIComponent(detail.group.id)}`);
    },
  });

  const logout = useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      // Drop every cached query so the next user on this browser sees nothing of ours.
      queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      queryClient.setQueryData(['me'], null);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    create.mutate();
  }

  const items = groups.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <main className="card wide">
      <header className="row">
        <h1>Trips</h1>
        <span>
          {user.name} ·{' '}
          <button className="link" onClick={() => logout.mutate()} disabled={logout.isPending}>
            Log out
          </button>
        </span>
      </header>
      {logout.error && <p className="error">{logout.error.message}</p>}

      <PendingSettlements />

      <h2>New group</h2>
      <form onSubmit={submit}>
        <input placeholder="Group name (e.g. Goa trip)" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        {create.error && <p className="error">{create.error.message}</p>}
        <button disabled={create.isPending}>{create.isPending ? 'Creating…' : 'Create group'}</button>
      </form>

      <h2>My groups</h2>
      {groups.isPending && <p>Loading groups…</p>}
      {groups.error && <p className="error">{groups.error.message}</p>}
      {groups.isSuccess && items.length === 0 && <p className="muted">No groups yet. Create one or open an invite link.</p>}
      <ul className="list">
        {items.map((g) => (
          <li key={g.id} className="row">
            <Link to={`/groups/${encodeURIComponent(g.id)}`}>
              <strong>{g.name}</strong>
            </Link>
            <span className="muted">
              {g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}
            </span>
          </li>
        ))}
      </ul>
      {groups.hasNextPage && (
        <button onClick={() => groups.fetchNextPage()} disabled={groups.isFetchingNextPage}>
          {groups.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </main>
  );
}

function PendingSettlements() {
  const queryClient = useQueryClient();

  const pending = useQuery({
    queryKey: ['pending-settlements'],
    queryFn: () => api<{ items: Settlement[] }>('/settlements/pending'),
  });

  // Settlements carry member ids only; look up names through the (cached) group details.
  const groupIds = [...new Set((pending.data?.items ?? []).flatMap((s) => s.legs.map((l) => l.groupId)))];
  const details = useQueries({
    queries: groupIds.map((gid) => ({
      queryKey: ['group', gid],
      queryFn: () => api<GroupDetail>(`/groups/${encodeURIComponent(gid)}`),
    })),
  });
  function payerName(s: Settlement): string | null {
    const leg = s.legs[0];
    if (!leg) return null;
    const d = details.find((q) => q.data?.group.id === leg.groupId)?.data;
    return d?.members.find((m) => m.id === leg.fromMemberId)?.displayName ?? null;
  }

  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'confirm' | 'reject' }) =>
      api<{ settlement: Settlement }>(`/settlements/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
    onSuccess: () =>
      Promise.all([
        // A batch can span several groups, so refresh all group data.
        queryClient.invalidateQueries({ queryKey: ['group'] }),
        queryClient.invalidateQueries({ queryKey: ['pending-settlements'] }),
        queryClient.invalidateQueries({ queryKey: ['settle-with'] }),
      ]),
  });

  const items = pending.data?.items ?? [];
  if (pending.isSuccess && items.length === 0) return null;

  return (
    <section>
      <h2>Waiting for your confirmation</h2>
      {pending.isPending && <p>Loading…</p>}
      {pending.error && <p className="error">{pending.error.message}</p>}
      {decide.error && <p className="error">{decide.error.message}</p>}
      <ul className="list">
        {items.map((s) => {
          const from = payerName(s);
          return (
            <li key={s.id}>
              <div className="row">
                <strong>
                  {from ? `${from} paid you ` : 'You were paid '}
                  {formatINR(s.netAmount)}
                </strong>
                <span className="muted">
                  {s.method} · {s.legs.length} {s.legs.length === 1 ? 'group' : 'groups'}
                </span>
              </div>
              {s.note && <p>{s.note}</p>}
              <div className="actions">
                <button onClick={() => decide.mutate({ id: s.id, action: 'confirm' })} disabled={decide.isPending}>
                  Confirm
                </button>
                <button className="link danger" onClick={() => decide.mutate({ id: s.id, action: 'reject' })} disabled={decide.isPending}>
                  Reject
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
