// Pure money logic: no database, no Express. All amounts are integer paise.
// CONTRACT (frozen): routes depend on these signatures. Implementation: agent A.
import { HttpError } from './httpError.js';

export type SplitType = 'equal' | 'exact' | 'shares';

/** One participant of a split, in the order given (the route passes them in member join order). */
export type SplitInput = { memberId: string; shares?: number; amount?: number };
export type SplitLine = { memberId: string; shares?: number; amount: number };

export type MoneyLine = { memberId: string; amount: number };
export type LedgerExpense = { payers: MoneyLine[]; splits: MoneyLine[] };
export type Transfer = { fromMemberId: string; toMemberId: string; amount: number };
/** Positive = the group owes this member money (creditor). Negative = this member owes (debtor). */
export type Balances = Record<string, number>;

/**
 * Resolve each participant's share of `total`.
 * - equal:  only memberId allowed; total / n, leftover paise +1 to the first participants in order.
 * - exact:  amount (integer >= 0) required for each; amounts must sum to total.
 * - shares: shares (integer >= 1) required for each; floor(total * shares / sumShares), leftover paise +1 in order.
 * Throws HttpError(400) on: no participants, duplicate memberId, wrong fields for the type, bad sum.
 */
export function splitAmount(total: number, type: SplitType, parts: SplitInput[]): SplitLine[] {
  if (!Number.isSafeInteger(total) || total <= 0) throw new HttpError(400, 'Total must be a positive integer (paise)');
  if (parts.length === 0) throw new HttpError(400, 'At least one participant is required');
  const seen = new Set<string>();
  for (const p of parts) {
    if (seen.has(p.memberId)) throw new HttpError(400, 'Duplicate participant in split');
    seen.add(p.memberId);
    const hasShares = p.shares !== undefined;
    const hasAmount = p.amount !== undefined;
    if (type === 'equal' && (hasShares || hasAmount)) {
      throw new HttpError(400, 'Equal split takes no shares or amount');
    }
    if (type === 'exact' && (hasShares || !Number.isSafeInteger(p.amount) || (p.amount as number) < 0)) {
      throw new HttpError(400, 'Exact split needs an integer amount >= 0 for each participant, and no shares');
    }
    if (type === 'shares' && (hasAmount || !Number.isSafeInteger(p.shares) || (p.shares as number) < 1)) {
      throw new HttpError(400, 'Shares split needs integer shares >= 1 for each participant, and no amount');
    }
  }

  if (type === 'exact') {
    const sum = parts.reduce((acc, p) => acc + (p.amount as number), 0);
    if (sum !== total) throw new HttpError(400, 'Split amounts must add up to the total');
    return parts.map((p) => ({ memberId: p.memberId, amount: p.amount as number }));
  }

  if (type === 'equal') {
    const n = parts.length;
    const base = Math.floor(total / n); // both integers: exact
    const leftover = total - base * n;
    return parts.map((p, i) => ({ memberId: p.memberId, amount: base + (i < leftover ? 1 : 0) }));
  }

  // shares: integer math in BigInt so total * shares never loses precision
  const big = BigInt(total);
  const sumShares = parts.reduce((acc, p) => acc + BigInt(p.shares as number), 0n);
  const amounts = parts.map((p) => Number((big * BigInt(p.shares as number)) / sumShares));
  const leftover = total - amounts.reduce((a, b) => a + b, 0); // 0 <= leftover < n
  return parts.map((p, i) => ({
    memberId: p.memberId,
    shares: p.shares as number,
    amount: amounts[i] + (i < leftover ? 1 : 0),
  }));
}

/**
 * Net balance per member: paid - owed + confirmed transfers sent - confirmed transfers received.
 * Every id in memberIds appears in the result (0 if untouched). The values always sum to 0.
 */
export function netBalances(memberIds: string[], expenses: LedgerExpense[], transfers: Transfer[]): Balances {
  const net = new Map<string, number>();
  for (const id of memberIds) net.set(id, 0);
  const add = (id: string, delta: number) => {
    const cur = net.get(id);
    if (cur === undefined) throw new HttpError(500, 'Ledger references a member outside the group');
    net.set(id, cur + delta);
  };
  for (const e of expenses) {
    for (const p of e.payers) add(p.memberId, p.amount);
    for (const s of e.splits) add(s.memberId, -s.amount);
  }
  for (const t of transfers) {
    add(t.fromMemberId, t.amount);
    add(t.toMemberId, -t.amount);
  }
  const out: Balances = {};
  for (const [id, v] of net) out[id] = v;
  return out;
}

type Entry = { id: string; bal: number };

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Largest debtor pays largest creditor until everyone is 0. Ties by memberId. Appends to `out`. */
function settleGreedy(group: Entry[], out: Transfer[]): void {
  const bal = group.map((e) => ({ ...e })).sort(byId);
  for (;;) {
    let debtor: Entry | undefined;
    let creditor: Entry | undefined;
    for (const e of bal) {
      if (e.bal < 0 && (!debtor || e.bal < debtor.bal)) debtor = e;
      if (e.bal > 0 && (!creditor || e.bal > creditor.bal)) creditor = e;
    }
    if (!debtor || !creditor) return;
    const amount = Math.min(-debtor.bal, creditor.bal);
    out.push({ fromMemberId: debtor.id, toMemberId: creditor.id, amount });
    debtor.bal += amount;
    creditor.bal -= amount;
  }
}

/** Partition `items` (sum 0) into the maximum number of zero-sum groups. n <= MAX_DP. */
function maxZeroSumGroups(items: Entry[]): Entry[][] {
  const n = items.length;
  const size = 1 << n;
  const sum = new Float64Array(size); // safe: exact integers well below 2^53
  const dp = new Int8Array(size); // dp[mask] <= n/2 <= 10
  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask;
    const i = 31 - Math.clz32(low);
    sum[mask] = sum[mask ^ low] + items[i].bal;
    let best = 0;
    for (let rest = mask; rest; rest &= rest - 1) {
      const v = dp[mask ^ (rest & -rest)];
      if (v > best) best = v;
    }
    dp[mask] = best + (sum[mask] === 0 ? 1 : 0);
  }

  // Walk back from the full mask; each non-empty zero-sum mask on the chain closes a group.
  const groups: Entry[][] = [];
  let mask = size - 1;
  let groupMask = 0;
  while (mask) {
    const need = dp[mask] - (sum[mask] === 0 ? 1 : 0);
    if (sum[mask] === 0 && groupMask) {
      groups.push(maskToEntries(items, groupMask));
      groupMask = 0;
    }
    let i = 0;
    while (!((mask >> i) & 1) || dp[mask ^ (1 << i)] !== need) i++;
    groupMask |= 1 << i;
    mask ^= 1 << i;
  }
  if (groupMask) groups.push(maskToEntries(items, groupMask));
  return groups;
}

function maskToEntries(items: Entry[], mask: number): Entry[] {
  return items.filter((_, i) => (mask >> i) & 1);
}

const MAX_DP = 20;

/**
 * Fewest payments that bring every balance to 0 (balances must sum to 0).
 * 1. drop zeros; 2. exact opposite amounts pay each other in full;
 * 3. bitmask DP: max number of disjoint zero-sum subsets => minimum payments (n <= 20);
 * 4. within each subset, largest debtor pays largest creditor; ties broken by memberId for determinism.
 */
export function minimizePayments(balances: Balances): Transfer[] {
  let total = 0;
  const entries: Entry[] = [];
  for (const [id, bal] of Object.entries(balances)) {
    if (!Number.isSafeInteger(bal)) throw new HttpError(500, 'Balances must be integer paise');
    total += bal;
    if (bal !== 0) entries.push({ id, bal });
  }
  if (total !== 0) throw new HttpError(500, 'Balances do not sum to zero');
  entries.sort(byId);

  const out: Transfer[] = [];

  // Exact opposite amounts: one full payment each, matched in memberId order.
  const debtorsByAmount = new Map<number, Entry[]>();
  for (const e of entries) {
    if (e.bal < 0) {
      const list = debtorsByAmount.get(-e.bal) ?? [];
      list.push(e);
      debtorsByAmount.set(-e.bal, list);
    }
  }
  const paired = new Set<string>();
  for (const c of entries) {
    if (c.bal <= 0) continue;
    const d = debtorsByAmount.get(c.bal)?.shift();
    if (!d) continue;
    out.push({ fromMemberId: d.id, toMemberId: c.id, amount: c.bal });
    paired.add(c.id);
    paired.add(d.id);
  }
  const rest = entries.filter((e) => !paired.has(e.id));

  if (rest.length > MAX_DP) {
    settleGreedy(rest, out);
  } else if (rest.length > 0) {
    for (const group of maxZeroSumGroups(rest)) settleGreedy(group, out);
  }

  return out.sort((a, b) =>
    a.fromMemberId < b.fromMemberId ? -1 : a.fromMemberId > b.fromMemberId ? 1
      : a.toMemberId < b.toMemberId ? -1 : a.toMemberId > b.toMemberId ? 1 : 0,
  );
}
