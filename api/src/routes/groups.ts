import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  GroupMemberModel,
  GroupModel,
  INVITE_TTL_MS,
  MAX_GROUP_MEMBERS,
  toGroupDTO,
  toMemberDTO,
} from '../models/Group.js';
import { UserModel } from '../models/User.js';
import { currentUserId, requireAuth } from '../middleware/auth.js';
import { HttpError } from '../lib/httpError.js';
import { objectId } from '../lib/ids.js';
import {
  INVITE_CODE_RE,
  computeGroupBalances,
  isDuplicateKey,
  loadMembers,
  requireMembership,
  withFreshInviteCode,
} from '../lib/groupLedger.js';

export const groupsRouter = Router();
groupsRouter.use(requireAuth);

const createSchema = z.strictObject({ name: z.string().trim().min(1).max(80) });
const addMemberSchema = z.strictObject({ displayName: z.string().trim().min(1).max(80) });
const listQuerySchema = z.object({
  cursor: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

function inviteExpiry() {
  return new Date(Date.now() + INVITE_TTL_MS);
}

async function loadUserName(userId: string): Promise<string> {
  const user = await UserModel.findById(userId).select('name').lean();
  if (!user) throw new HttpError(401, 'Not authenticated');
  return user.name;
}

/**
 * Adds a member without exceeding the cap, even under concurrent joins (no transactions on standalone MongoDB):
 * 1. reserve a seat with a conditional $inc (only matches while memberCount < 20); 2. insert the member;
 * 3. if the insert fails (e.g. duplicate key from a concurrent double join), give the seat back.
 */
async function addMemberWithCap(groupId: string, doc: { userId?: string; displayName: string; addedByUserId: string }) {
  const reserved = await GroupModel.findOneAndUpdate(
    { _id: groupId, memberCount: mongoose.trusted({ $lt: MAX_GROUP_MEMBERS }) },
    { $inc: { memberCount: 1 } },
  ).lean();
  if (!reserved) throw new HttpError(409, 'Group is full');
  try {
    // userId is omitted (not null) for name-only members, so the partial unique index and $exists checks work.
    return await GroupMemberModel.create({ groupId, ...doc });
  } catch (err) {
    await GroupModel.updateOne({ _id: groupId }, { $inc: { memberCount: -1 } });
    throw err;
  }
}

groupsRouter.post('/', async (req, res) => {
  const { name } = createSchema.parse(req.body);
  const me = currentUserId(req);
  const displayName = await loadUserName(me);
  const group = await withFreshInviteCode((code) =>
    GroupModel.create({ name, ownerUserId: me, memberCount: 1, inviteCode: code, inviteExpiresAt: inviteExpiry() }),
  );
  let member;
  try {
    member = await GroupMemberModel.create({ groupId: group._id, userId: me, displayName, addedByUserId: me });
  } catch (err) {
    await GroupModel.deleteOne({ _id: group._id }); // no transactions: undo the half-created group
    throw err;
  }
  res.status(201).json({
    group: toGroupDTO(group.toObject(), { includeInvite: true }),
    members: [toMemberDTO(member.toObject())],
    myMemberId: String(member._id),
  });
});

// My groups, newest membership first. Cursor is the membership _id (index userId,_id); groups load in one $in query.
groupsRouter.get('/', async (req, res) => {
  const { cursor, limit } = listQuerySchema.parse(req.query);
  const me = currentUserId(req);
  const rows = await GroupMemberModel.find({
    userId: me,
    ...(cursor ? { _id: mongoose.trusted({ $lt: cursor }) } : {}),
  })
    .sort({ _id: -1 })
    .limit(limit + 1)
    .select('groupId')
    .lean();
  const page = rows.slice(0, limit);
  const groups = await GroupModel.find({ _id: mongoose.trusted({ $in: page.map((r) => r.groupId) }) }).lean();
  const byId = new Map(groups.map((g) => [String(g._id), g]));
  const items = page.flatMap((r) => {
    const g = byId.get(String(r.groupId));
    return g ? [toGroupDTO(g, { includeInvite: String(g.ownerUserId) === me })] : [];
  });
  res.json({ items, nextCursor: rows.length > limit ? String(page[page.length - 1]._id) : null });
});

groupsRouter.get('/:gid', async (req, res) => {
  const { groupId, me } = await requireMembership(req);
  const [group, members] = await Promise.all([GroupModel.findById(groupId).lean(), loadMembers(groupId)]);
  if (!group) throw new HttpError(404, 'Group not found');
  res.json({
    group: toGroupDTO(group, { includeInvite: String(group.ownerUserId) === currentUserId(req) }),
    members: members.map(toMemberDTO),
    myMemberId: String(me._id),
  });
});

// Any member can add a name-only member (a friend without an account yet).
groupsRouter.post('/:gid/members', async (req, res) => {
  const { groupId } = await requireMembership(req);
  const { displayName } = addMemberSchema.parse(req.body);
  const member = await addMemberWithCap(groupId, { displayName, addedByUserId: currentUserId(req) });
  res.status(201).json({ member: toMemberDTO(member.toObject()) });
});

// Owner only: a new 24h code; the old one stops working because the field is overwritten.
groupsRouter.post('/:gid/invite', async (req, res) => {
  const { groupId } = await requireMembership(req);
  const me = currentUserId(req);
  const group = await GroupModel.findById(groupId).select('ownerUserId').lean();
  if (!group) throw new HttpError(404, 'Group not found');
  if (String(group.ownerUserId) !== me) throw new HttpError(403, 'Only the group owner can create invites');
  const updated = await withFreshInviteCode((code) =>
    GroupModel.findOneAndUpdate(
      { _id: groupId, ownerUserId: me },
      { $set: { inviteCode: code, inviteExpiresAt: inviteExpiry() } },
      { returnDocument: 'after' },
    ).lean(),
  );
  if (!updated) throw new HttpError(404, 'Group not found');
  res.json({ invite: toGroupDTO(updated, { includeInvite: true }).invite });
});

groupsRouter.get('/:gid/balances', async (req, res) => {
  const { groupId } = await requireMembership(req);
  const { balances, suggestedPayments } = await computeGroupBalances(groupId);
  res.json({ balances, suggestedPayments });
});

// ---- Join by invite code: /api/join/:code ----

export const joinRouter = Router();
// Limits guessing of invite codes (and join spam) per IP.
joinRouter.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 }));
joinRouter.use(requireAuth);

const joinSchema = z.strictObject({ claimMemberId: objectId.optional() });

// Unknown, malformed or expired code → 404 (same answer for all, so codes can't be probed).
async function findGroupByCode(code: string) {
  if (!INVITE_CODE_RE.test(code)) throw new HttpError(404, 'Invite not found or expired');
  const group = await GroupModel.findOne({
    inviteCode: code,
    inviteExpiresAt: mongoose.trusted({ $gt: new Date() }),
  }).lean();
  if (!group) throw new HttpError(404, 'Invite not found or expired');
  return group;
}

joinRouter.get('/:code', async (req, res) => {
  const group = await findGroupByCode(req.params.code);
  const me = currentUserId(req);
  const members = await loadMembers(String(group._id));
  res.json({
    group: { id: String(group._id), name: group.name, memberCount: group.memberCount ?? 0 },
    nameOnlyMembers: members.filter((m) => !m.userId).map((m) => ({ id: String(m._id), displayName: m.displayName })),
    alreadyMember: members.some((m) => m.userId && String(m.userId) === me),
  });
});

joinRouter.post('/:code', async (req, res) => {
  const group = await findGroupByCode(req.params.code);
  const { claimMemberId } = joinSchema.parse(req.body ?? {});
  const me = currentUserId(req);
  const groupId = String(group._id);

  // Joining twice changes nothing.
  if (await GroupMemberModel.exists({ groupId, userId: me })) {
    res.json({ groupId });
    return;
  }

  const displayName = await loadUserName(me);
  try {
    if (claimMemberId) {
      // Take over a name-only member: only matches if it is in this group and nobody has claimed it yet.
      // memberCount doesn't change: the seat already exists.
      const claimed = await GroupMemberModel.findOneAndUpdate(
        { _id: claimMemberId, groupId, userId: mongoose.trusted({ $exists: false }) },
        { $set: { userId: me, displayName } },
        { returnDocument: 'after' },
      ).lean();
      if (!claimed) throw new HttpError(409, 'That member is not available to claim');
    } else {
      await addMemberWithCap(groupId, { userId: me, displayName, addedByUserId: me });
    }
  } catch (err) {
    // Duplicate (groupId,userId): a concurrent request already made me a member. Same outcome as joining twice.
    if (!isDuplicateKey(err)) throw err;
  }
  res.json({ groupId });
});
