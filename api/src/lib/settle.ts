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
  void total;
  void type;
  void parts;
  throw new HttpError(500, 'splitAmount not implemented');
}

/**
 * Net balance per member: paid - owed + confirmed transfers sent - confirmed transfers received.
 * Every id in memberIds appears in the result (0 if untouched). The values always sum to 0.
 */
export function netBalances(memberIds: string[], expenses: LedgerExpense[], transfers: Transfer[]): Balances {
  void memberIds;
  void expenses;
  void transfers;
  throw new HttpError(500, 'netBalances not implemented');
}

/**
 * Fewest payments that bring every balance to 0 (balances must sum to 0).
 * 1. drop zeros; 2. exact opposite amounts pay each other in full;
 * 3. bitmask DP: max number of disjoint zero-sum subsets => minimum payments (n <= 20);
 * 4. within each subset, largest debtor pays largest creditor; ties broken by memberId for determinism.
 */
export function minimizePayments(balances: Balances): Transfer[] {
  void balances;
  throw new HttpError(500, 'minimizePayments not implemented');
}
