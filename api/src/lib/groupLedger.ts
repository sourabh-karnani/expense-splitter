import { randomInt } from 'node:crypto';
import type { Request } from 'express';
import mongoose from 'mongoose';
import { GroupMemberModel, MAX_GROUP_MEMBERS } from '../models/Group.js';
import { ExpenseModel } from '../models/Expense.js';
import { SettlementModel } from '../models/Settlement.js';
import { currentUserId } from '../middleware/auth.js';
import { HttpError } from './httpError.js';
import { objectId, parseIdOr404 } from './ids.js';
import { minimizePayments, netBalances, type Transfer } from './settle.js';

export type MemberRow = { _id: mongoose.Types.ObjectId; userId?: mongoose.Types.ObjectId | null; displayName: string; joinedAt?: Date | null };

// ---- Membership ----

/**
 * :gid from a (possibly mergeParams) router; malformed → 404. Lowercased, because ids are compared as strings
 * (e.g. settlement legs by groupId) and Mongo would happily match an uppercase id while those checks don't.
 */
export function groupIdParam(req: Request): string {
  const raw = (req.params as Record<string, string | undefined>).gid ?? '';
  return parseIdOr404(raw, 'Group').toLowerCase();
}

/** A member id in a body, lowercased so string comparisons against loaded members are exact. */
export const memberIdField = objectId.transform((id) => id.toLowerCase());

/**
 * Access to everything under /groups/:gid is by membership. Not a member (or no such group) → 404,
 * so group ids of other people's groups aren't confirmed.
 */
export async function requireMembership(req: Request) {
  const groupId = groupIdParam(req);
  const me = await GroupMemberModel.findOne({ groupId, userId: currentUserId(req) }).lean();
  if (!me) throw new HttpError(404, 'Group not found');
  return { groupId, me };
}

/** All members of a group in join order (_id order). The group cap bounds this to 20 rows. */
export async function loadMembers(groupId: string): Promise<MemberRow[]> {
  return GroupMemberModel.find({ groupId }).sort({ _id: 1 }).limit(MAX_GROUP_MEMBERS).lean();
}

/** Throws 400 unless every id belongs to the group (bodies must only reference this group's members). */
export function assertMembers(members: MemberRow[], ids: string[]) {
  const known = new Set(members.map((m) => String(m._id)));
  for (const id of ids) if (!known.has(id)) throw new HttpError(400, 'Member is not in this group');
}

// ---- Balances ----

/**
 * Confirmed balances of one group: non-deleted expenses + confirmed settlement legs of THIS group.
 * Returns rows in member join order, the suggested payments, and a memberId → balance map.
 */
export async function computeGroupBalances(groupId: string, preloadedMembers?: MemberRow[]) {
  const [members, expenses, settlements] = await Promise.all([
    preloadedMembers ?? loadMembers(groupId),
    ExpenseModel.find({ groupId, deletedAt: null }).select('payers splits').lean(),
    SettlementModel.find({ groupIds: groupId, status: 'confirmed' }).select('legs').lean(),
  ]);

  const memberIds = members.map((m) => String(m._id));
  const ledger = expenses.map((e) => ({
    payers: e.payers.map((p) => ({ memberId: String(p.memberId), amount: p.amount })),
    splits: e.splits.map((s) => ({ memberId: String(s.memberId), amount: s.amount })),
  }));
  const transfers: Transfer[] = settlements.flatMap((s) =>
    s.legs
      .filter((l) => String(l.groupId) === groupId)
      .map((l) => ({ fromMemberId: String(l.fromMemberId), toMemberId: String(l.toMemberId), amount: l.amount })),
  );

  const byMember = netBalances(memberIds, ledger, transfers);
  const suggestedPayments = minimizePayments(byMember);
  const balances = members.map((m) => ({
    memberId: String(m._id),
    displayName: m.displayName,
    amount: byMember[String(m._id)] ?? 0,
  }));
  return { members, balances, suggestedPayments, byMember };
}

/**
 * PENDING settlement legs in this group: how much `memberId` is paying (out) and receiving (in).
 * Counted when a new payment is recorded, so several pending payments can't add up to more than the debt
 * or more than the receiver is owed.
 */
export async function pendingFor(groupId: string, memberId: string): Promise<{ out: number; in: number }> {
  const pending = await SettlementModel.find({ groupIds: groupId, status: 'pending' }).select('legs').lean();
  const legs = pending.flatMap((s) => s.legs).filter((l) => String(l.groupId) === groupId);
  const sum = (key: 'fromMemberId' | 'toMemberId') =>
    legs.filter((l) => String(l[key]) === memberId).reduce((acc, l) => acc + l.amount, 0);
  return { out: sum('fromMemberId'), in: sum('toMemberId') };
}

/**
 * Re-checks every leg against the CURRENT confirmed balances: the payer must still owe at least the leg amount
 * and the receiver must still be owed at least that much in that group. Balances can change between recording
 * and confirming (other payments, edited expenses), so this runs right before a settlement is confirmed.
 * Throws 409 if a leg would overpay.
 */
export async function assertLegsStillOwed(
  legs: { groupId: unknown; fromMemberId: unknown; toMemberId: unknown; amount: number }[],
) {
  const groupIds = [...new Set(legs.map((l) => String(l.groupId)))];
  const balances = new Map(
    await Promise.all(groupIds.map(async (g) => [g, (await computeGroupBalances(g)).byMember] as const)),
  );
  for (const leg of legs) {
    const byMember = balances.get(String(leg.groupId)) ?? {};
    const owes = Math.max(0, -(byMember[String(leg.fromMemberId)] ?? 0));
    const isOwed = Math.max(0, byMember[String(leg.toMemberId)] ?? 0);
    if (leg.amount > Math.min(owes, isOwed)) {
      throw new HttpError(409, 'Balances changed since this payment was recorded and it would now overpay. Reject it and record a new one.');
    }
  }
}

// ---- Invite codes ----

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const INVITE_CODE_RE = /^[A-Za-z0-9]{10}$/;

/** 10 base62 characters from a CSPRNG (~59 bits), so codes can't be guessed or enumerated. */
export function generateInviteCode(): string {
  let code = '';
  for (let i = 0; i < 10; i++) code += BASE62[randomInt(BASE62.length)];
  return code;
}

export function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number })?.code === 11000;
}

/** Runs fn with fresh invite codes until it doesn't hit the unique index (collisions are astronomically rare). */
export async function withFreshInviteCode<T>(fn: (code: string) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(generateInviteCode());
    } catch (err) {
      if (!isDuplicateKey(err) || attempt >= 4) throw err;
    }
  }
}
