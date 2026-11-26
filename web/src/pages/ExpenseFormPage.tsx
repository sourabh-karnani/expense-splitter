import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type Expense, type ExpenseInput, type Member, type MoneyLine, type SplitType } from '../api';
import { formatINR, paiseToRupees, parseOptionalRupees, parseRupeesToPaise, todayLocal } from '../money';
import { invalidateGroupMoney, useGroupDetail } from './GroupPage';

export function ExpenseFormPage() {
  const { gid = '', eid } = useParams();
  const detail = useGroupDetail(gid);
  const expense = useQuery({
    queryKey: ['group', gid, 'expenses', eid],
    queryFn: () => api<{ expense: Expense }>(`/groups/${encodeURIComponent(gid)}/expenses/${encodeURIComponent(eid!)}`),
    enabled: !!eid,
  });

  const back = (
    <p>
      <Link to={`/groups/${encodeURIComponent(gid)}`}>← Back to group</Link>
    </p>
  );

  if (detail.isPending || (eid && expense.isPending)) return <p className="center">Loading…</p>;
  const error = detail.error ?? (eid ? expense.error : null);
  if (error) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <main className="card">
        {back}
        <p className="error">{notFound ? 'Not found.' : error.message}</p>
      </main>
    );
  }
  if (!detail.data) return null;

  const existing = eid ? expense.data?.expense : undefined;
  return (
    <main className="card wide">
      {back}
      <h1>{existing ? 'Edit expense' : 'Add expense'}</h1>
      {/* Remount with fresh values whenever a newer version is loaded (Reload after a 409). */}
      <ExpenseForm
        key={existing ? `${existing.id}-${existing.version}` : 'new'}
        gid={gid}
        members={detail.data.members}
        myMemberId={detail.data.myMemberId}
        existing={existing}
        reloading={expense.isFetching}
        onReload={() => void expense.refetch()}
      />
    </main>
  );
}

const SPLIT_LABELS: Record<SplitType, string> = { equal: 'Equal', exact: 'Exact', shares: 'Shares' };

function ExpenseForm({
  gid,
  members,
  myMemberId,
  existing,
  reloading,
  onReload,
}: {
  gid: string;
  members: Member[];
  myMemberId: string;
  existing?: Expense;
  reloading: boolean;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [amountText, setAmountText] = useState(existing ? paiseToRupees(existing.amount) : '');
  const [spentOn, setSpentOn] = useState(existing ? existing.spentOn.slice(0, 10) : todayLocal());
  const [splitType, setSplitType] = useState<SplitType>(existing?.splitType ?? 'equal');
  const [included, setIncluded] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(members.map((m) => [m.id, existing ? existing.splits.some((s) => s.memberId === m.id) : true])),
  );
  const [exactText, setExactText] = useState<Record<string, string>>(() =>
    existing?.splitType === 'exact' ? Object.fromEntries(existing.splits.map((s) => [s.memberId, paiseToRupees(s.amount)])) : {},
  );
  const [sharesText, setSharesText] = useState<Record<string, string>>(() =>
    existing?.splitType === 'shares' ? Object.fromEntries(existing.splits.map((s) => [s.memberId, String(s.shares ?? 1)])) : {},
  );
  const [multiPayer, setMultiPayer] = useState(!!existing && existing.payers.length > 1);
  const [payerId, setPayerId] = useState(existing?.payers.length === 1 ? existing.payers[0].memberId : myMemberId);
  const [payerText, setPayerText] = useState<Record<string, string>>(() =>
    existing && existing.payers.length > 1
      ? Object.fromEntries(existing.payers.map((p) => [p.memberId, paiseToRupees(p.amount)]))
      : {},
  );

  // ---- Live checks (the server validates again) ----
  const amount = parseRupeesToPaise(amountText);
  const problems: string[] = [];
  if (amountText && amount === null) problems.push('Amount must be a positive number with at most 2 decimals, e.g. 1234.50.');

  const participants = members.filter((m) => included[m.id]);
  if (participants.length === 0) problems.push('Pick at least one person to split with.');

  let payers: MoneyLine[] = [];
  let payerDiff = 0;
  if (!multiPayer) {
    payers = amount ? [{ memberId: payerId, amount }] : [];
  } else {
    let bad = false;
    for (const m of members) {
      const v = parseOptionalRupees(payerText[m.id] ?? '');
      if (v === null) bad = true;
      else if (v > 0) payers.push({ memberId: m.id, amount: v });
    }
    if (bad) problems.push('Each payer amount must be a number with at most 2 decimals.');
    payerDiff = (amount ?? 0) - payers.reduce((sum, p) => sum + p.amount, 0);
    if (amount && payerDiff !== 0) problems.push(`Payers must add up to the amount.`);
  }

  let splits: ExpenseInput['splits'] = [];
  let exactDiff = 0;
  if (splitType === 'equal') {
    splits = participants.map((m) => ({ memberId: m.id }));
  } else if (splitType === 'exact') {
    let bad = false;
    for (const m of participants) {
      const v = parseOptionalRupees(exactText[m.id] ?? '');
      if (v === null) bad = true;
      else if (v > 0) splits.push({ memberId: m.id, amount: v });
    }
    if (bad) problems.push('Each exact amount must be a number with at most 2 decimals.');
    exactDiff = (amount ?? 0) - splits.reduce((sum, s) => sum + (s.amount ?? 0), 0);
    if (amount && exactDiff !== 0) problems.push('Exact amounts must add up to the amount.');
  } else {
    let bad = false;
    for (const m of participants) {
      const t = (sharesText[m.id] ?? '1').trim();
      if (!/^\d+$/.test(t) || Number(t) < 1 || Number(t) > 1000) bad = true;
      else splits.push({ memberId: m.id, shares: Number(t) });
    }
    if (bad) problems.push('Shares must be whole numbers from 1 to 1000.');
  }

  const save = useMutation({
    mutationFn: () => {
      // Built field by field: the API rejects unknown fields.
      const input: ExpenseInput = {
        title: title.trim(),
        description: description.trim(),
        amount: amount!,
        spentOn,
        splitType,
        payers,
        splits,
      };
      const base = `/groups/${encodeURIComponent(gid)}/expenses`;
      return existing
        ? api<{ expense: Expense }>(`${base}/${encodeURIComponent(existing.id)}`, {
            method: 'PATCH',
            body: JSON.stringify({ ...input, version: existing.version }),
          })
        : api<{ expense: Expense }>(base, { method: 'POST', body: JSON.stringify(input) });
    },
    onSuccess: () => {
      void invalidateGroupMoney(queryClient, gid);
      navigate(`/groups/${encodeURIComponent(gid)}`);
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (amount !== null && problems.length === 0) save.mutate();
  }

  function toggleMulti() {
    if (!multiPayer && Object.keys(payerText).length === 0) setPayerText({ [payerId]: amountText });
    setMultiPayer(!multiPayer);
  }

  const conflict = save.error instanceof ApiError && save.error.status === 409;

  return (
    <form onSubmit={submit}>
      <input placeholder="Title (e.g. Dinner)" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
      <textarea placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
      <div className="inline">
        <label>
          Amount (₹)
          <input inputMode="decimal" placeholder="0.00" value={amountText} onChange={(e) => setAmountText(e.target.value)} required />
        </label>
        <label>
          Date
          <input type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} required />
        </label>
      </div>

      <fieldset>
        <legend>Paid by</legend>
        {!multiPayer ? (
          <select value={payerId} onChange={(e) => setPayerId(e.target.value)} aria-label="Payer">
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
                {m.id === myMemberId ? ' (you)' : ''}
              </option>
            ))}
          </select>
        ) : (
          <>
            {members.map((m) => (
              <label key={m.id} className="member-row">
                <span>
                  {m.displayName}
                  {m.id === myMemberId ? ' (you)' : ''}
                </span>
                <input
                  inputMode="decimal"
                  placeholder="0"
                  value={payerText[m.id] ?? ''}
                  onChange={(e) => setPayerText({ ...payerText, [m.id]: e.target.value })}
                />
              </label>
            ))}
            {amount !== null && <Remaining diff={payerDiff} />}
          </>
        )}
        <button type="button" className="link" onClick={toggleMulti}>
          {multiPayer ? 'Single payer' : 'Multiple payers'}
        </button>
      </fieldset>

      <fieldset>
        <legend>Split</legend>
        <div className="tabs" role="tablist">
          {(Object.keys(SPLIT_LABELS) as SplitType[]).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={splitType === t}
              className={splitType === t ? 'tab active' : 'tab'}
              onClick={() => setSplitType(t)}
            >
              {SPLIT_LABELS[t]}
            </button>
          ))}
        </div>
        {members.map((m) => (
          <div key={m.id} className="member-row">
            <label>
              <input
                type="checkbox"
                checked={!!included[m.id]}
                onChange={(e) => setIncluded({ ...included, [m.id]: e.target.checked })}
              />{' '}
              {m.displayName}
              {m.id === myMemberId ? ' (you)' : ''}
            </label>
            {included[m.id] && splitType === 'exact' && (
              <input
                inputMode="decimal"
                placeholder="₹ 0"
                aria-label={`Amount for ${m.displayName}`}
                value={exactText[m.id] ?? ''}
                onChange={(e) => setExactText({ ...exactText, [m.id]: e.target.value })}
              />
            )}
            {included[m.id] && splitType === 'shares' && (
              <input
                inputMode="numeric"
                aria-label={`Shares for ${m.displayName}`}
                value={sharesText[m.id] ?? '1'}
                onChange={(e) => setSharesText({ ...sharesText, [m.id]: e.target.value })}
              />
            )}
          </div>
        ))}
        {splitType === 'exact' && amount !== null && <Remaining diff={exactDiff} />}
        {splitType === 'equal' && amount !== null && participants.length > 0 && (
          <p className="muted">About {formatINR(Math.floor(amount / participants.length))} each.</p>
        )}
      </fieldset>

      {problems.map((p) => (
        <p key={p} className="error">
          {p}
        </p>
      ))}
      {save.error && (
        <div className="error">
          {conflict ? (
            <>
              <p>Someone else changed this expense, reload to see their version.</p>
              <p className="muted">{save.error.message}</p>
              {existing && (
                <button type="button" onClick={onReload} disabled={reloading}>
                  {reloading ? 'Reloading…' : 'Reload'}
                </button>
              )}
            </>
          ) : (
            <p>{save.error.message}</p>
          )}
        </div>
      )}
      <button disabled={save.isPending || amount === null || problems.length > 0}>
        {save.isPending ? 'Saving…' : existing ? 'Save changes' : 'Add expense'}
      </button>
    </form>
  );
}

function Remaining({ diff }: { diff: number }) {
  if (diff === 0) return <p className="pos">Adds up ✓</p>;
  return <p className="neg">{diff > 0 ? `${formatINR(diff)} left to assign` : `${formatINR(-diff)} too much`}</p>;
}
