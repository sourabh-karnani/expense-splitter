import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type JoinPreview } from '../api';

export function JoinPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const preview = useQuery({
    queryKey: ['join', code],
    queryFn: () => api<JoinPreview>(`/join/${encodeURIComponent(code)}`),
  });

  const join = useMutation({
    mutationFn: (claimMemberId?: string) =>
      api<{ groupId: string }>(`/join/${encodeURIComponent(code)}`, {
        method: 'POST',
        body: JSON.stringify(claimMemberId ? { claimMemberId } : {}),
      }),
    onSuccess: ({ groupId }) => {
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
      void queryClient.invalidateQueries({ queryKey: ['group', groupId] });
      queryClient.removeQueries({ queryKey: ['join', code] });
      navigate(`/groups/${encodeURIComponent(groupId)}`);
    },
  });

  if (preview.isPending) return <p className="center">Loading invite…</p>;
  if (preview.error) {
    const invalid = preview.error instanceof ApiError && preview.error.status === 404;
    return (
      <main className="card">
        <p className="error">{invalid ? 'This invite link is invalid or expired.' : preview.error.message}</p>
        <Link to="/">Go to my groups</Link>
      </main>
    );
  }

  const { group, nameOnlyMembers, alreadyMember } = preview.data;

  return (
    <main className="card">
      <h1>Join {group.name}</h1>
      <p className="muted">
        {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
      </p>

      {alreadyMember ? (
        <p>
          You are already in this group. <Link to={`/groups/${encodeURIComponent(group.id)}`}>Open it</Link>
        </p>
      ) : (
        <>
          <button onClick={() => join.mutate(undefined)} disabled={join.isPending}>
            {join.isPending ? 'Joining…' : 'Join as myself'}
          </button>
          {nameOnlyMembers.length > 0 && (
            <>
              <h2>Or I am one of these people:</h2>
              <ul className="list compact">
                {nameOnlyMembers.map((m) => (
                  <li key={m.id} className="row">
                    <span>{m.displayName}</span>
                    <button className="link" onClick={() => join.mutate(m.id)} disabled={join.isPending}>
                      That's me
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {join.error && <p className="error">{join.error.message}</p>}
        </>
      )}
    </main>
  );
}
