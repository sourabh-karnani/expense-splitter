import { Router } from 'express';
import mongoose from 'mongoose';
import { z } from 'zod';
import {
  ExpenseModel,
  MAX_AMOUNT,
  MAX_EXPENSE_VERSION,
  SPLIT_TYPES,
  toExpenseDTO,
  toRevisionDTO,
} from '../models/Expense.js';
import { MAX_GROUP_MEMBERS } from '../models/Group.js';
import { requireAuth } from '../middleware/auth.js';
import { HttpError } from '../lib/httpError.js';
import { objectId, parseIdOr404 } from '../lib/ids.js';
import { assertMembers, loadMembers, memberIdField, requireMembership, type MemberRow } from '../lib/groupLedger.js';
import { splitAmount, type SplitInput, type SplitType } from '../lib/settle.js';

// Mounted at /api/groups/:gid/expenses. Every route checks membership of :gid first (non-member → 404).
export const expensesRouter = Router({ mergeParams: true });
expensesRouter.use(requireAuth);

const money = z.number().int().min(1).max(MAX_AMOUNT);
const inputFields = {
  title: z.string().trim().min(1).max(120),
  description: z.string().max(1000).optional(),
  amount: money,
  spentOn: z.iso.date().optional(), // YYYY-MM-DD, defaults to today
  splitType: z.enum(SPLIT_TYPES),
  payers: z.array(z.strictObject({ memberId: memberIdField, amount: money })).min(1).max(MAX_GROUP_MEMBERS),
  splits: z
    .array(
      z.strictObject({
        memberId: memberIdField,
        shares: z.number().int().min(1).max(10_000).optional(), // bounded so total * shares stays a safe integer
        amount: z.number().int().min(0).max(MAX_AMOUNT).optional(),
      }),
    )
    .min(1)
    .max(MAX_GROUP_MEMBERS),
};
const createSchema = z.strictObject(inputFields);
const updateSchema = z.strictObject({ ...inputFields, version: z.number().int().min(1) });
const deleteQuerySchema = z.object({ version: z.coerce.number().int().min(1) });
const listQuerySchema = z.object({
  cursor: objectId.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

type ExpenseInput = z.infer<typeof createSchema>;
type Line = { memberId: unknown; amount: number; shares?: number | null };
type Fields = {
  title: string;
  description: string;
  amount: number;
  spentOn: Date;
  splitType: SplitType;
  payers: { memberId: string; amount: number }[];
  splits: { memberId: string; amount: number; shares?: number }[];
};

function todayUtc() {
  return new Date(new Date().toISOString().slice(0, 10));
}

function hasDuplicates(ids: string[]) {
  return new Set(ids).size !== ids.length;
}

/**
 * Validates an expense body against the group's members and resolves the splits.
 * Payers and split members must be members of this group, payers must add up to the amount.
 * Parts are sorted into member join order before splitAmount, so leftover paise land deterministically.
 */
function resolveExpense(input: ExpenseInput, members: MemberRow[]): Fields {
  const payerIds = input.payers.map((p) => p.memberId);
  const splitIds = input.splits.map((s) => s.memberId);
  if (hasDuplicates(payerIds)) throw new HttpError(400, 'A member can only appear once in payers');
  if (hasDuplicates(splitIds)) throw new HttpError(400, 'A member can only appear once in splits');
  assertMembers(members, [...payerIds, ...splitIds]);
  const paid = input.payers.reduce((sum, p) => sum + p.amount, 0);
  if (paid !== input.amount) throw new HttpError(400, 'Payers must add up to the amount');

  const joinOrder = new Map(members.map((m, i) => [String(m._id), i]));
  const byJoinOrder = (a: { memberId: string }, b: { memberId: string }) =>
    joinOrder.get(a.memberId)! - joinOrder.get(b.memberId)!;
  const parts: SplitInput[] = [...input.splits].sort(byJoinOrder).map((s) => ({
    memberId: s.memberId,
    ...(s.shares !== undefined ? { shares: s.shares } : {}),
    ...(s.amount !== undefined ? { amount: s.amount } : {}),
  }));
  const splits = splitAmount(input.amount, input.splitType, parts).map((s) => ({
    memberId: s.memberId,
    amount: s.amount,
    ...(s.shares ? { shares: s.shares } : {}),
  }));

  return {
    title: input.title,
    description: input.description ?? '',
    amount: input.amount,
    spentOn: input.spentOn ? new Date(input.spentOn) : todayUtc(),
    splitType: input.splitType,
    payers: [...input.payers].sort(byJoinOrder).map((p) => ({ memberId: p.memberId, amount: p.amount })),
    splits,
  };
}

/** The revision snapshot: the expense's user-visible fields after the action, ids as strings. */
function snapshotOf(e: {
  title: string;
  description?: string | null;
  amount: number;
  spentOn: Date;
  splitType: string;
  payers: Line[];
  splits: Line[];
}) {
  return {
    title: e.title,
    description: e.description ?? '',
    amount: e.amount,
    spentOn: e.spentOn,
    splitType: e.splitType,
    payers: e.payers.map((p) => ({ memberId: String(p.memberId), amount: p.amount })),
    splits: e.splits.map((s) => ({ memberId: String(s.memberId), amount: s.amount, ...(s.shares ? { shares: s.shares } : {}) })),
  };
}

function expenseIdParam(raw: string | undefined) {
  return parseIdOr404(raw ?? '', 'Expense');
}

/** After a conditional update matched nothing: 404 if the expense is gone, else someone changed it first. */
async function notFoundOrConflict(eid: string, groupId: string, conflictMessage: string): Promise<never> {
  const exists = await ExpenseModel.exists({ _id: eid, groupId, deletedAt: null });
  if (!exists) throw new HttpError(404, 'Expense not found');
  throw new HttpError(409, conflictMessage);
}

const STALE = 'Expense was changed by someone else';

expensesRouter.get('/', async (req, res) => {
  const { groupId } = await requireMembership(req);
  const { cursor, limit } = listQuerySchema.parse(req.query);
  const rows = await ExpenseModel.find({
    groupId,
    deletedAt: null,
    ...(cursor ? { _id: mongoose.trusted({ $lt: cursor }) } : {}),
  })
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
  const page = rows.slice(0, limit);
  res.json({
    items: page.map(toExpenseDTO),
    nextCursor: rows.length > limit ? String(page[page.length - 1]._id) : null,
  });
});

expensesRouter.post('/', async (req, res) => {
  const { groupId, me } = await requireMembership(req);
  const input = createSchema.parse(req.body);
  const fields = resolveExpense(input, await loadMembers(groupId));
  const expense = await ExpenseModel.create({
    groupId,
    ...fields,
    version: 1,
    createdByMemberId: me._id,
    updatedByMemberId: me._id,
    revisions: [{ version: 1, action: 'create', byMemberId: me._id, at: new Date(), snapshot: snapshotOf(fields) }],
  });
  res.status(201).json({ expense: toExpenseDTO(expense.toObject()) });
});

expensesRouter.get('/:eid', async (req, res) => {
  const { groupId } = await requireMembership(req);
  const eid = expenseIdParam(req.params.eid);
  const expense = await ExpenseModel.findOne({ _id: eid, groupId, deletedAt: null }).lean();
  if (!expense) throw new HttpError(404, 'Expense not found');
  res.json({ expense: toExpenseDTO(expense) });
});

// Full replacement + optimistic concurrency: the update only matches the version the client read.
expensesRouter.patch('/:eid', async (req, res) => {
  const { groupId, me } = await requireMembership(req);
  const eid = expenseIdParam(req.params.eid);
  const { version, ...input } = updateSchema.parse(req.body);
  if (version >= MAX_EXPENSE_VERSION) {
    return notFoundOrConflict(eid, groupId, 'This expense has reached its edit limit');
  }
  const fields = resolveExpense(input, await loadMembers(groupId));
  const expense = await ExpenseModel.findOneAndUpdate(
    { _id: eid, groupId, deletedAt: null, version },
    {
      $set: { ...fields, updatedByMemberId: me._id },
      $inc: { version: 1 },
      $push: {
        revisions: { version: version + 1, action: 'update', byMemberId: me._id, at: new Date(), snapshot: snapshotOf(fields) },
      },
    },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!expense) return notFoundOrConflict(eid, groupId, STALE);
  res.json({ expense: toExpenseDTO(expense) });
});

// Soft delete with the same version check. Not capped by MAX_EXPENSE_VERSION, so a heavily edited expense can still be deleted.
expensesRouter.delete('/:eid', async (req, res) => {
  const { groupId, me } = await requireMembership(req);
  const eid = expenseIdParam(req.params.eid);
  const { version } = deleteQuerySchema.parse(req.query);
  const current = await ExpenseModel.findOne({ _id: eid, groupId, deletedAt: null }).lean();
  if (!current) throw new HttpError(404, 'Expense not found');
  if (current.version !== version) throw new HttpError(409, STALE);
  // The version filter guarantees the snapshot below is of the exact version being deleted.
  const now = new Date();
  const deleted = await ExpenseModel.findOneAndUpdate(
    { _id: eid, groupId, deletedAt: null, version },
    {
      $set: { deletedAt: now, updatedByMemberId: me._id },
      $inc: { version: 1 },
      $push: { revisions: { version: version + 1, action: 'delete', byMemberId: me._id, at: now, snapshot: snapshotOf(current) } },
    },
  ).lean();
  if (!deleted) return notFoundOrConflict(eid, groupId, STALE);
  res.status(204).end();
});

// History stays readable after a delete, so this lookup doesn't filter on deletedAt.
expensesRouter.get('/:eid/history', async (req, res) => {
  const { groupId } = await requireMembership(req);
  const eid = expenseIdParam(req.params.eid);
  const expense = await ExpenseModel.findOne({ _id: eid, groupId }).select('+revisions').lean();
  if (!expense) throw new HttpError(404, 'Expense not found');
  res.json({ revisions: [...(expense.revisions ?? [])].reverse().map(toRevisionDTO) });
});
