import { Router, type Request } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import { SETTLEMENT_METHODS, SETTLEMENT_STATUSES, SettlementModel, toSettlementDTO } from '../models/Settlement.js';
import { MAX_AMOUNT } from '../models/Expense.js';
import { GroupMemberModel, GroupModel } from '../models/Group.js';
import { UserModel } from '../models/User.js';
import { currentUserId, requireAuth } from '../middleware/auth.js';
import { HttpError } from '../lib/httpError.js';
import { objectId, parseIdOr404 } from '../lib/ids.js';
import {
  assertLegsStillOwed,
  assertMembers,
  computeGroupBalances,
  loadMembers,
  memberIdField,
  pendingFor,
  requireMembership,
} from '../lib/groupLedger.js';

const MAX_SHARED_GROUPS = 50; // settle-with looks at no more than 50 shared groups
const MAX_MY_GROUPS = 500; // bound on the "my memberships" scan used to find shared groups
const PENDING_LIMIT = 50;

const noteField = z.string().trim().max(200).optional();
const methodField = z.enum(SETTLEMENT_METHODS);

// ---- Per-group settlements: /api/groups/:gid/settlements ----

export const groupSettlementsRouter = Router({ mergeParams: true });
groupSettlementsRouter.use(requireAuth);

const createSchema = z.strictObject({
  fromMemberId: memberIdField,
  toMemberId: memberIdField,
  amount: z.number().int().min(1).max(MAX_AMOUNT),
  method: methodField,
  note: noteField,
});
const listQuerySchema = z.object({
  cursor: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

groupSettlementsRouter.post('/', async (req, res) => {
  const { groupId, me } = await requireMembership(req);
  const { fromMemberId, toMemberId, amount, method, note } = createSchema.parse(req.body);
  if (fromMemberId === toMemberId) throw new HttpError(400, 'Payer and receiver must be different members');

  const members = await loadMembers(groupId);
  assertMembers(members, [fromMemberId, toMemberId]);
  const from = members.find((m) => String(m._id) === fromMemberId)!;
  const to = members.find((m) => String(m._id) === toMemberId)!;
  const myMemberId = String(me._id);
  const iAmParty = myMemberId === fromMemberId || myMemberId === toMemberId;

  // Who may record: the payer or the receiver. A third member may record only when neither side has an
  // account (two name-only friends). A third member recording between account holders → 403, because the
  // body is valid but the caller lacks the right to act for them.
  if (!iAmParty && (from.userId || to.userId)) {
    throw new HttpError(403, 'Only the payer or the receiver can record this payment');
  }

  // Capped by both sides, on confirmed balances minus payments still waiting for confirmation:
  // no more than `from` still owes, and no more than `to` is still owed (paying someone more than they're owed
  // would flip them into debt).
  const [{ byMember }, fromPending, toPending] = await Promise.all([
    computeGroupBalances(groupId, members),
    pendingFor(groupId, fromMemberId),
    pendingFor(groupId, toMemberId),
  ]);
  const owes = Math.max(0, -(byMember[fromMemberId] ?? 0) - fromPending.out);
  const isOwed = Math.max(0, (byMember[toMemberId] ?? 0) - toPending.in);
  if (amount > owes) {
    throw new HttpError(400, `Amount is more than ${from.displayName} still owes (${owes}, after pending payments)`);
  }
  if (amount > isOwed) {
    throw new HttpError(400, `Amount is more than ${to.displayName} is still owed (${isOwed}, after pending payments)`);
  }

  // Confirmed at once if the receiver records it, or the receiver has no account to confirm with.
  const confirmed = myMemberId === toMemberId || !to.userId;
  const settlement = await SettlementModel.create({
    ...(from.userId ? { fromUserId: from.userId } : {}),
    ...(to.userId ? { toUserId: to.userId } : {}),
    createdByUserId: currentUserId(req),
    method,
    note: note ?? '',
    netAmount: amount,
    status: confirmed ? 'confirmed' : 'pending',
    decidedAt: confirmed ? new Date() : null,
    legs: [{ groupId, fromMemberId, toMemberId, amount }],
    groupIds: [groupId],
  });
  res.status(201).json({ settlement: toSettlementDTO(settlement.toObject()) });
});

// Every status, newest first. A cross-group batch is shown with only this group's legs, so members of this
// group don't see the other groups involved.
groupSettlementsRouter.get('/', async (req, res) => {
  const { groupId } = await requireMembership(req);
  const { cursor, limit } = listQuerySchema.parse(req.query);
  const rows = await SettlementModel.find({
    groupIds: groupId,
    // $in over every status lets the (groupIds, status, _id) index serve the _id sort (merge of 3 ranges).
    status: mongoose.trusted({ $in: [...SETTLEMENT_STATUSES] }),
    ...(cursor ? { _id: mongoose.trusted({ $lt: cursor }) } : {}),
  })
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
  const page = rows.slice(0, limit);
  res.json({
    items: page.map((s) => toSettlementDTO({ ...s, legs: s.legs.filter((l) => String(l.groupId) === groupId) })),
    nextCursor: rows.length > limit ? String(page[page.length - 1]._id) : null,
  });
});

// ---- My settlements: /api/settlements ----

export const settlementsRouter = Router();
settlementsRouter.use(requireAuth);

settlementsRouter.get('/pending', async (req, res) => {
  const rows = await SettlementModel.find({ toUserId: currentUserId(req), status: 'pending' })
    .sort({ _id: -1 })
    .limit(PENDING_LIMIT)
    .lean();
  res.json({ items: rows.map(toSettlementDTO) });
});

// Only the receiver decides, and only while pending: one conditional update, so confirming twice can't count twice.
function decide(status: 'confirmed' | 'rejected') {
  return async (req: Request<{ id: string }>, res: import('express').Response) => {
    const id = parseIdOr404(req.params.id, 'Settlement');
    if (status === 'confirmed') {
      const current = await SettlementModel.findOne({ _id: id, toUserId: currentUserId(req), status: 'pending' })
        .select('legs')
        .lean();
      if (!current) throw new HttpError(404, 'Settlement not found');
      await assertLegsStillOwed(current.legs); // balances may have moved since it was recorded
    }
    const settlement = await SettlementModel.findOneAndUpdate(
      { _id: id, toUserId: currentUserId(req), status: 'pending' },
      { $set: { status, decidedAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
    if (!settlement) throw new HttpError(404, 'Settlement not found');
    res.json({ settlement: toSettlementDTO(settlement) });
  };
}

settlementsRouter.post('/:id/confirm', decide('confirmed'));
settlementsRouter.post('/:id/reject', decide('rejected'));

// ---- Pairwise settle across shared groups: /api/settle-with/:userId ----

export const settleWithRouter = Router();
settleWithRouter.use(requireAuth);

const settleWithSchema = z.strictObject({ method: methodField, note: noteField });

/**
 * For every group we share: compute the suggested payments and keep only those between my member and theirs.
 * Net them from my point of view. Always recomputed on the server; the client never sends legs.
 */
async function buildSettleWith(req: Request<{ userId: string }>) {
  const me = currentUserId(req);
  const otherId = parseIdOr404(req.params.userId, 'User').toLowerCase();
  if (otherId === me) throw new HttpError(404, 'No shared groups');

  const mine = await GroupMemberModel.find({ userId: me }).sort({ _id: -1 }).limit(MAX_MY_GROUPS).select('groupId').lean();
  const theirs = await GroupMemberModel.find({
    userId: otherId,
    groupId: mongoose.trusted({ $in: mine.map((m) => m.groupId) }),
  })
    .sort({ _id: 1 })
    .limit(MAX_SHARED_GROUPS)
    .select('groupId')
    .lean();
  if (theirs.length === 0) throw new HttpError(404, 'No shared groups');

  const myMemberByGroup = new Map(mine.map((m) => [String(m.groupId), String(m._id)]));
  const [other, groups] = await Promise.all([
    UserModel.findById(otherId).select('name').lean(),
    GroupModel.find({ _id: mongoose.trusted({ $in: theirs.map((t) => t.groupId) }) }).select('name').lean(),
  ]);
  if (!other) throw new HttpError(404, 'No shared groups');
  const groupName = new Map(groups.map((g) => [String(g._id), g.name]));

  const perGroup = await Promise.all(
    theirs.map(async (t) => {
      const groupId = String(t.groupId);
      const mineId = myMemberByGroup.get(groupId)!;
      const theirId = String(t._id);
      const { suggestedPayments } = await computeGroupBalances(groupId);
      return suggestedPayments
        .filter(
          (p) =>
            (p.fromMemberId === mineId && p.toMemberId === theirId) ||
            (p.fromMemberId === theirId && p.toMemberId === mineId),
        )
        .map((p) => ({ groupId, groupName: groupName.get(groupId) ?? '', ...p, iPay: p.fromMemberId === mineId }));
    }),
  );
  const legs = perGroup.flat();
  const net = legs.reduce((sum, l) => sum + (l.iPay ? l.amount : -l.amount), 0);
  const direction: 'i_pay' | 'they_pay' | 'even' = net > 0 ? 'i_pay' : net < 0 ? 'they_pay' : 'even';
  return { me, other: { id: otherId, name: other.name }, legs, direction, netAmount: Math.abs(net) };
}

settleWithRouter.get('/:userId', async (req, res) => {
  const { other, legs, direction, netAmount } = await buildSettleWith(req);
  res.json({
    otherUser: other,
    legs: legs.map(({ groupId, groupName, fromMemberId, toMemberId, amount }) => ({
      groupId,
      groupName,
      fromMemberId,
      toMemberId,
      amount,
    })),
    direction,
    netAmount,
  });
});

settleWithRouter.post('/:userId', async (req, res) => {
  const { method, note } = settleWithSchema.parse(req.body);
  const { me, other, legs, direction, netAmount } = await buildSettleWith(req);
  if (legs.length === 0) throw new HttpError(400, 'Nothing to settle');

  // The legs come from confirmed balances only, so a payment already waiting between us would be counted twice.
  // Two equality queries (each served by the toUserId+status index) instead of a $or, which sanitizeFilter
  // would need wrapping for.
  const pendingBetweenUs = await Promise.all([
    SettlementModel.exists({ toUserId: other.id, status: 'pending', fromUserId: me }),
    SettlementModel.exists({ toUserId: me, status: 'pending', fromUserId: other.id }),
  ]);
  if (pendingBetweenUs.some(Boolean)) {
    throw new HttpError(409, 'A payment between you two is still waiting for confirmation. Confirm or reject it first.');
  }

  // they_pay: I'm the receiver, so it counts at once. i_pay / even: pending until they confirm.
  const theyPay = direction === 'they_pay';
  const settlement = await SettlementModel.create({
    fromUserId: theyPay ? other.id : me,
    toUserId: theyPay ? me : other.id,
    createdByUserId: me,
    method,
    note: note ?? '',
    netAmount,
    status: theyPay ? 'confirmed' : 'pending',
    decidedAt: theyPay ? new Date() : null,
    legs: legs.map(({ groupId, fromMemberId, toMemberId, amount }) => ({ groupId, fromMemberId, toMemberId, amount })),
    groupIds: [...new Set(legs.map((l) => l.groupId))],
  });
  res.status(201).json({ settlement: toSettlementDTO(settlement.toObject()) });
});
