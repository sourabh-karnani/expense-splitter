export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Every request goes to /api on the same origin (Vite proxies it to the API),
// so the httpOnly session cookie is sent automatically. No tokens in JavaScript.
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}

export type User = { id: string; email: string; name: string };
export type Note = { id: string; title: string; body: string; createdAt: string; updatedAt: string };
export type Page<T> = { items: T[]; nextCursor: string | null };

// ---- Expense splitter (contract: see PLAN.md "API contract"). All amounts are integer paise. ----
export type Invite = { code: string; expiresAt: string | null };
export type Group = {
  id: string;
  name: string;
  currency: string;
  ownerUserId: string;
  memberCount: number;
  invite: Invite | null; // only for the owner
  createdAt: string;
};
export type Member = { id: string; userId: string | null; displayName: string; isNameOnly: boolean; joinedAt: string | null };
export type GroupDetail = { group: Group; members: Member[]; myMemberId: string };
export type SplitType = 'equal' | 'exact' | 'shares';
export type MoneyLine = { memberId: string; amount: number };
export type SplitLine = { memberId: string; amount: number; shares?: number };
export type Expense = {
  id: string;
  groupId: string;
  title: string;
  description: string;
  amount: number;
  spentOn: string;
  splitType: SplitType;
  payers: MoneyLine[];
  splits: SplitLine[];
  version: number;
  createdByMemberId: string;
  updatedByMemberId: string;
  createdAt: string;
  updatedAt: string;
};
export type ExpenseInput = {
  title: string;
  description?: string;
  amount: number;
  spentOn?: string; // YYYY-MM-DD
  splitType: SplitType;
  payers: MoneyLine[];
  splits: { memberId: string; shares?: number; amount?: number }[];
};
export type Revision = {
  version: number;
  action: 'create' | 'update' | 'delete';
  byMemberId: string;
  at: string;
  snapshot: Omit<ExpenseInput, 'splits'> & { splits: SplitLine[] };
};
export type Transfer = { fromMemberId: string; toMemberId: string; amount: number };
export type BalanceRow = { memberId: string; displayName: string; amount: number }; // + is owed, - owes
export type BalancesResponse = { balances: BalanceRow[]; suggestedPayments: Transfer[] };
export type SettlementMethod = 'cash' | 'upi' | 'bank' | 'other';
export type Settlement = {
  id: string;
  fromUserId: string | null;
  toUserId: string | null;
  createdByUserId: string;
  method: SettlementMethod;
  note: string;
  netAmount: number;
  status: 'pending' | 'confirmed' | 'rejected';
  decidedAt: string | null;
  legs: (Transfer & { groupId: string })[];
  createdAt: string;
};
export type JoinPreview = { group: { id: string; name: string; memberCount: number }; nameOnlyMembers: { id: string; displayName: string }[]; alreadyMember: boolean };
export type SettleWithPreview = {
  otherUser: { id: string; name: string };
  legs: (Transfer & { groupId: string; groupName: string })[];
  direction: 'i_pay' | 'they_pay' | 'even';
  netAmount: number;
};
