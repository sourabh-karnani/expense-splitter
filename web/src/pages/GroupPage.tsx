import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  api,
  ApiError,
  type BalancesResponse,
  type Expense,
  type GroupDetail,
  type Invite,
  type Member,
  type Page,
  type Revision,
  type Settlement,
  type SettlementMethod,
  type Transfer,
  type User,
} from '../api';
import { formatINR, paiseToRupees, parseRupeesToPaise } from '../money';

export const METHODS: SettlementMethod[] = ['cash', 'upi', 'bank', 'other'];

// Any expense or settlement change in a group: refresh that group's data (balances, expenses,
// settlements, single expense + history all live under ['group', gid]) and the cross-group views.
export function invalidateGroupMoney(queryClient: QueryClient, gid: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ['group', gid] }),
    queryClient.invalidateQueries({ queryKey: ['pending-settlements'] }),
    queryClient.invalidateQueries({ queryKey: ['settle-with'] }),
  ]);
}

export function useGroupDetail(gid: string) {
  return useQuery({
    queryKey: ['group', gid],
    queryFn: () => api<GroupDetail>(`/groups/${encodeURIComponent(gid)}`),
  });
}

type Names = (memberId: string) => string;

export function GroupPage({ user }: { user: User }) {
  const { gid = '' } = useParams();
  const detail = useGroupDetail(gid);

  if (detail.isPending) return <p className="center">Loading group…</p>;
  if (detail.error) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <main className="card">
        <p className="error">{notFound ? 'Group not found.' : detail.error.message}</p>
        <Link to="/">Back to groups</Link>
      </main>
    );
  }

  const { group, members, myMemberId } = detail.data;
  const byId = new Map(members.map((m) => [m.id, m]));
  const names: Names = (id) => byId.get(id)?.displayName ?? 'Former member';
  const isOwner = group.ownerUserId === user.id;

  return (
    <main className="card wide">
      <p>
        <Link to="/">← All groups</Link>
      </p>
      <h1>{group.name}</h1>

      <MembersSection gid={gid} members={members} myMemberId={myMemberId} />
      {isOwner && group.invite && <InviteSection gid={gid} invite={group.invite} />}
      <BalancesSection gid={gid} names={names} byId={byId} myMemberId={myMemberId} />
      <ExpensesSection gid={gid} names={names} />
      <SettlementsSection gid={gid} names={names} />
    </main>
  );
}

function MembersSection({ gid, members, myMemberId }: { gid: string; members: Member[]; myMemberId: string }) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState('');

  const add = useMutation({
    mutationFn: () =>
      api<{ member: Member }>(`/groups/${encodeURIComponent(gid)}/members`, {
        method: 'POST',
        body: JSON.stringify({ displayName }),
      }),
    onSuccess: () => {
      setDisplayName('');
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: ['group', gid] }),
        queryClient.invalidateQueries({ queryKey: ['groups'] }),
      ]);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    add.mutate();
  }

  return (
    <section>
      <h2>Members</h2>
      <ul className="list compact">
        {members.map((m) => (
          <li key={m.id} className="row">
            <span>
              {m.displayName}
              {m.id === myMemberId && <span className="muted"> (you)</span>}
              {m.isNameOnly && <span className="muted"> · name only</span>}
            </span>
            {m.userId && m.id !== myMemberId && (
              <Link to={`/settle/${encodeURIComponent(m.userId)}`}>Settle all groups</Link>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="inline">
        <input
          placeholder="Add person without account"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          required
          maxLength={80}
        />
        <button disabled={add.isPending}>{add.isPending ? 'Adding…' : 'Add'}</button>
      </form>
      {add.error && <p className="error">{add.error.message}</p>}
    </section>
  );
}

function InviteSection({ gid, invite }: { gid: string; invite: Invite }) {
  const queryClient = useQueryClient();
  const link = `${window.location.origin}/j/${invite.code}`;

  const copy = useMutation({ mutationFn: () => navigator.clipboard.writeText(link) });

  const regenerate = useMutation({
    mutationFn: () => api<{ invite: Invite }>(`/groups/${encodeURIComponent(gid)}/invite`, { method: 'POST' }),
    onSuccess: () => {
      copy.reset();
      return queryClient.invalidateQueries({ queryKey: ['group', gid], exact: true });
    },
  });

  return (
    <section>
      <h2>Invite</h2>
      <div className="inline">
        <input readOnly value={link} onFocus={(e) => e.target.select()} aria-label="Invite link" />
        <button onClick={() => copy.mutate()} disabled={copy.isPending}>
          {copy.isSuccess ? 'Copied' : 'Copy'}
        </button>
      </div>
      {copy.error && <p className="error">Could not copy: {copy.error.message}</p>}
      <p className="muted">
        {invite.expiresAt ? `Expires ${new Date(invite.expiresAt).toLocaleString()}` : 'No expiry'} ·{' '}
        <button className="link" onClick={() => regenerate.mutate()} disabled={regenerate.isPending}>
          {regenerate.isPending ? 'Creating…' : 'New link'}
        </button>
      </p>
      {regenerate.error && <p className="error">{regenerate.error.message}</p>}
    </section>
  );
}

function BalancesSection({
  gid,
  names,
  byId,
  myMemberId,
}: {
  gid: string;
  names: Names;
  byId: Map<string, Member>;
  myMemberId: string;
}) {
  // Kept here, not in the payment row: the row unmounts when balances refetch.
  const [message, setMessage] = useState<string | null>(null);

  const balances = useQuery({
    queryKey: ['group', gid, 'balances'],
    queryFn: () => api<BalancesResponse>(`/groups/${encodeURIComponent(gid)}/balances`),
  });

  function canRecord(t: Transfer) {
    const from = byId.get(t.fromMemberId);
    const to = byId.get(t.toMemberId);
    return t.fromMemberId === myMemberId || t.toMemberId === myMemberId || (!from?.userId && !to?.userId);
  }

  return (
    <section>
      <h2>Balances</h2>
      {balances.isPending && <p>Loading balances…</p>}
      {balances.error && <p className="error">{balances.error.message}</p>}
      {balances.data && (
        <>
          <ul className="list compact">
            {balances.data.balances.map((b) => (
              <li key={b.memberId} className="row">
                <span>{b.displayName}</span>
                {b.amount > 0 ? (
                  <span className="pos">is owed {formatINR(b.amount)}</span>
                ) : b.amount < 0 ? (
                  <span className="neg">owes {formatINR(-b.amount)}</span>
                ) : (
                  <span className="muted">settled up</span>
                )}
              </li>
            ))}
          </ul>
          <h3>Suggested payments</h3>
          {message && <p className="notice">{message}</p>}
          {balances.data.suggestedPayments.length === 0 && <p className="muted">Everyone is settled up.</p>}
          <ul className="list">
            {balances.data.suggestedPayments.map((t) => (
              <li key={`${t.fromMemberId}-${t.toMemberId}-${t.amount}`}>
                <strong>
                  {names(t.fromMemberId)} pays {names(t.toMemberId)} {formatINR(t.amount)}
                </strong>
                {canRecord(t) && <RecordPayment gid={gid} transfer={t} toName={names(t.toMemberId)} onDone={setMessage} />}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RecordPayment({
  gid,
  transfer,
  toName,
  onDone,
}: {
  gid: string;
  transfer: Transfer;
  toName: string;
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amountText, setAmountText] = useState(paiseToRupees(transfer.amount));
  const [method, setMethod] = useState<SettlementMethod>('cash');
  const [note, setNote] = useState('');
  const amount = parseRupeesToPaise(amountText);

  const record = useMutation({
    mutationFn: () =>
      api<{ settlement: Settlement }>(`/groups/${encodeURIComponent(gid)}/settlements`, {
        method: 'POST',
        body: JSON.stringify({
          fromMemberId: transfer.fromMemberId,
          toMemberId: transfer.toMemberId,
          amount,
          method,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      }),
    onSuccess: ({ settlement }) => {
      onDone(
        settlement.status === 'pending'
          ? `Waiting for ${toName} to confirm ${formatINR(amount ?? 0)}.`
          : `Payment of ${formatINR(amount ?? 0)} to ${toName} recorded.`,
      );
      setOpen(false);
      return invalidateGroupMoney(queryClient, gid);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (amount !== null) record.mutate();
  }

  if (!open)
    return (
      <div>
        <button className="link" onClick={() => setOpen(true)}>
          Record payment
        </button>
      </div>
    );

  return (
    <form onSubmit={submit} className="sub">
      <label>
        Amount (₹)
        <input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} required />
      </label>
      {amountText && amount === null && <p className="error">Enter an amount like 250 or 250.50.</p>}
      {amount !== null && amount > transfer.amount && (
        <p className="muted">That is more than the suggested {formatINR(transfer.amount)}; the server will check it.</p>
      )}
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
      <div className="actions">
        <button disabled={record.isPending || amount === null}>{record.isPending ? 'Saving…' : 'Record payment'}</button>
        <button type="button" className="link" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function ExpensesSection({ gid, names }: { gid: string; names: Names }) {
  const expenses = useInfiniteQuery({
    queryKey: ['group', gid, 'expenses'],
    queryFn: ({ pageParam }) =>
      api<Page<Expense>>(
        `/groups/${encodeURIComponent(gid)}/expenses?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const items = expenses.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section>
      <div className="row">
        <h2>Expenses</h2>
        <Link to={`/groups/${encodeURIComponent(gid)}/expenses/new`}>+ Add expense</Link>
      </div>
      {expenses.isPending && <p>Loading expenses…</p>}
      {expenses.error && <p className="error">{expenses.error.message}</p>}
      {expenses.isSuccess && items.length === 0 && <p className="muted">No expenses yet.</p>}
      <ul className="list">
        {items.map((e) => (
          <ExpenseItem key={e.id} gid={gid} expense={e} names={names} />
        ))}
      </ul>
      {expenses.hasNextPage && (
        <button onClick={() => expenses.fetchNextPage()} disabled={expenses.isFetchingNextPage}>
          {expenses.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}

function ExpenseItem({ gid, expense, names }: { gid: string; expense: Expense; names: Names }) {
  const queryClient = useQueryClient();
  const [showHistory, setShowHistory] = useState(false);

  const remove = useMutation({
    mutationFn: () =>
      api<void>(
        `/groups/${encodeURIComponent(gid)}/expenses/${encodeURIComponent(expense.id)}?version=${expense.version}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => invalidateGroupMoney(queryClient, gid),
  });

  function onDelete() {
    if (window.confirm(`Delete "${expense.title}"?`)) remove.mutate();
  }

  return (
    <li>
      <div className="row">
        <strong>{expense.title}</strong>
        <strong>{formatINR(expense.amount)}</strong>
      </div>
      <p className="muted">
        Paid by {expense.payers.map((p) => names(p.memberId)).join(', ')} · {expense.spentOn.slice(0, 10)} · {expense.splitType} split
      </p>
      {expense.description && <p>{expense.description}</p>}
      <div className="actions">
        <Link to={`/groups/${encodeURIComponent(gid)}/expenses/${encodeURIComponent(expense.id)}/edit`}>Edit</Link>
        <button className="link danger" onClick={onDelete} disabled={remove.isPending}>
          {remove.isPending ? 'Deleting…' : 'Delete'}
        </button>
        <button className="link" onClick={() => setShowHistory(!showHistory)}>
          {showHistory ? 'Hide history' : 'History'}
        </button>
      </div>
      {remove.error && (
        <p className="error">
          {remove.error instanceof ApiError && remove.error.status === 409
            ? 'Someone else changed this expense. Refresh and try again.'
            : remove.error.message}
        </p>
      )}
      {showHistory && <ExpenseHistory gid={gid} eid={expense.id} names={names} />}
    </li>
  );
}

function ExpenseHistory({ gid, eid, names }: { gid: string; eid: string; names: Names }) {
  const history = useQuery({
    queryKey: ['group', gid, 'expenses', eid, 'history'],
    queryFn: () =>
      api<{ revisions: Revision[] }>(`/groups/${encodeURIComponent(gid)}/expenses/${encodeURIComponent(eid)}/history`),
  });

  if (history.isPending) return <p>Loading history…</p>;
  if (history.error) return <p className="error">{history.error.message}</p>;

  return (
    <ol className="history">
      {history.data.revisions.map((r) => (
        <li key={r.version}>
          v{r.version} · {r.action} by {names(r.byMemberId)} · {new Date(r.at).toLocaleString()} —{' '}
          {r.snapshot.title}, {formatINR(r.snapshot.amount)}
        </li>
      ))}
    </ol>
  );
}

function SettlementsSection({ gid, names }: { gid: string; names: Names }) {
  const settlements = useInfiniteQuery({
    queryKey: ['group', gid, 'settlements'],
    queryFn: ({ pageParam }) =>
      api<Page<Settlement>>(
        `/groups/${encodeURIComponent(gid)}/settlements?limit=20${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });

  const items = settlements.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <section>
      <h2>Settlements</h2>
      {settlements.isPending && <p>Loading settlements…</p>}
      {settlements.error && <p className="error">{settlements.error.message}</p>}
      {settlements.isSuccess && items.length === 0 && <p className="muted">No payments recorded yet.</p>}
      <ul className="list">
        {items.map((s) =>
          // A batch can cover several groups; show only this group's leg(s).
          s.legs
            .filter((l) => l.groupId === gid)
            .map((l, i) => (
              <li key={`${s.id}-${i}`} className="row">
                <span>
                  {names(l.fromMemberId)} paid {names(l.toMemberId)} <strong>{formatINR(l.amount)}</strong>
                  <span className="muted"> · {s.method}</span>
                  {s.note && <span className="muted"> · {s.note}</span>}
                </span>
                <span className={`status ${s.status}`}>{s.status}</span>
              </li>
            )),
        )}
      </ul>
      {settlements.hasNextPage && (
        <button onClick={() => settlements.fetchNextPage()} disabled={settlements.isFetchingNextPage}>
          {settlements.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
}
