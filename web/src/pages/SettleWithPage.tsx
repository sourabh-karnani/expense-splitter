import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type GroupDetail, type Settlement, type SettlementMethod, type SettleWithPreview, type User } from '../api';
import { formatINR } from '../money';
import { METHODS } from './GroupPage';

export function SettleWithPage({ user }: { user: User }) {
  const { userId = '' } = useParams();
  const queryClient = useQueryClient();
  const [method, setMethod] = useState<SettlementMethod>('upi');
  const [note, setNote] = useState('');
  const [result, setResult] = useState<Settlement | null>(null);

  const preview = useQuery({
    queryKey: ['settle-with', userId],
    queryFn: () => api<SettleWithPreview>(`/settle-with/${encodeURIComponent(userId)}`),
  });

  // The preview's legs carry member ids only; my member id per group comes from the group detail.
  const legGroupIds = [...new Set((preview.data?.legs ?? []).map((l) => l.groupId))];
  const details = useQueries({
    queries: legGroupIds.map((gid) => ({
      queryKey: ['group', gid],
      queryFn: () => api<GroupDetail>(`/groups/${encodeURIComponent(gid)}`),
    })),
  });
  const myMemberIds = new Set(details.map((d) => d.data?.myMemberId).filter(Boolean));

  const record = useMutation({
    mutationFn: () =>
      api<{ settlement: Settlement }>(`/settle-with/${encodeURIComponent(userId)}`, {
        method: 'POST',
        body: JSON.stringify({ method, ...(note.trim() ? { note: note.trim() } : {}) }),
      }),
    onSuccess: ({ settlement }) => {
      setResult(settlement);
      setNote('');
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ['group'] }),
        queryClient.invalidateQueries({ queryKey: ['pending-settlements'] }),
        queryClient.invalidateQueries({ queryKey: ['settle-with'] }),
      ]);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    record.mutate();
  }

  const back = (
    <p>
      <Link to="/">← All groups</Link>
    </p>
  );

  if (preview.isPending) return <p className="center">Loading…</p>;
  if (preview.error) {
    const none = preview.error instanceof ApiError && preview.error.status === 404;
    return (
      <main className="card">
        {back}
        <p className="error">{none ? 'You share no groups with this person.' : preview.error.message}</p>
      </main>
    );
  }

  const { otherUser, legs, direction, netAmount } = preview.data;
  const them = otherUser.name;
  const headline =
    direction === 'i_pay'
      ? `You pay ${them} ${formatINR(netAmount)}`
      : direction === 'they_pay'
        ? `${them} pays you ${formatINR(netAmount)}`
        : "You're even";

  return (
    <main className="card wide">
      {back}
      <h1>Settle up with {them}</h1>
      <p className="muted">Signed in as {user.name}. One payment covers every group you share.</p>

      {legs.length === 0 ? (
        <p className="muted">Nothing to settle across your shared groups.</p>
      ) : (
        <ul className="list compact">
          {legs.map((l, i) => {
            const known = myMemberIds.size > 0;
            const iPay = myMemberIds.has(l.fromMemberId);
            return (
              <li key={`${l.groupId}-${i}`} className="row">
                <Link to={`/groups/${encodeURIComponent(l.groupId)}`}>{l.groupName}</Link>
                <span className={known ? (iPay ? 'neg' : 'pos') : undefined}>
                  {known ? (iPay ? `You pay ${them}` : `${them} pays you`) : 'Payment'} {formatINR(l.amount)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {details.some((d) => d.error) && <p className="error">Could not load some group details.</p>}

      <h2>{headline}</h2>
      {direction === 'even' && legs.length > 0 && (
        <p className="muted">Your debts cancel out; recording this clears them in every group once {them} confirms.</p>
      )}

      {result && (
        <p className="notice">
          {result.status === 'pending'
            ? `Recorded. Waiting for ${them} to confirm.`
            : result.status === 'confirmed'
              ? 'Recorded and confirmed.'
              : `Settlement ${result.status}.`}
        </p>
      )}

      {legs.length > 0 && !result && (
        <form onSubmit={submit}>
          <label>
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value as SettlementMethod)}>
              {METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          {record.error && <p className="error">{record.error.message}</p>}
          <button disabled={record.isPending}>{record.isPending ? 'Saving…' : 'Record settlement'}</button>
        </form>
      )}
    </main>
  );
}
