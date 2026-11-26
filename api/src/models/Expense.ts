import { Schema, model } from 'mongoose';

export const SPLIT_TYPES = ['equal', 'exact', 'shares'] as const;
export const MAX_EXPENSE_VERSION = 50; // caps the embedded revision history
export const MAX_AMOUNT = 10_000_000_00; // ₹1 crore, in paise

// All amounts are integer paise. An expense with its payers, splits and edit history is ONE document,
// so create, edit and delete are single atomic writes (standalone MongoDB has no transactions).
const payerSchema = new Schema(
  {
    memberId: { type: Schema.Types.ObjectId, ref: 'GroupMember', required: true },
    amount: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const splitSchema = new Schema(
  {
    memberId: { type: Schema.Types.ObjectId, ref: 'GroupMember', required: true },
    shares: { type: Number, min: 1 },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const revisionSchema = new Schema(
  {
    version: { type: Number, required: true },
    action: { type: String, enum: ['create', 'update', 'delete'], required: true },
    byMemberId: { type: Schema.Types.ObjectId, ref: 'GroupMember', required: true },
    at: { type: Date, required: true },
    // Snapshot of the expense fields after this action: title, description, amount, spentOn, splitType, payers, splits.
    snapshot: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

const expenseSchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 1000 },
    amount: { type: Number, required: true, min: 1, max: MAX_AMOUNT },
    spentOn: { type: Date, required: true },
    splitType: { type: String, enum: SPLIT_TYPES, required: true },
    payers: { type: [payerSchema], required: true },
    splits: { type: [splitSchema], required: true },
    version: { type: Number, default: 1 },
    createdByMemberId: { type: Schema.Types.ObjectId, ref: 'GroupMember', required: true },
    updatedByMemberId: { type: Schema.Types.ObjectId, ref: 'GroupMember', required: true },
    deletedAt: { type: Date, default: null },
    // select: false keeps history out of list/balance queries; the history endpoint selects it explicitly.
    revisions: { type: [revisionSchema], default: [], select: false },
  },
  { timestamps: true },
);

// Serves the group's expense list (newest first, cursor on _id) and the balance scan.
expenseSchema.index({ groupId: 1, deletedAt: 1, _id: -1 });

export const ExpenseModel = model('Expense', expenseSchema);

type Line = { memberId: unknown; amount: number; shares?: number | null };
type ExpenseLike = {
  _id: unknown;
  groupId: unknown;
  title: string;
  description?: string | null;
  amount: number;
  spentOn: Date;
  splitType: string;
  payers: Line[];
  splits: Line[];
  version?: number | null;
  createdByMemberId: unknown;
  updatedByMemberId: unknown;
  createdAt?: Date;
  updatedAt?: Date;
};

function toLine(l: Line) {
  return { memberId: String(l.memberId), amount: l.amount, ...(l.shares ? { shares: l.shares } : {}) };
}

export function toExpenseDTO(e: ExpenseLike) {
  return {
    id: String(e._id),
    groupId: String(e.groupId),
    title: e.title,
    description: e.description ?? '',
    amount: e.amount,
    spentOn: e.spentOn,
    splitType: e.splitType,
    payers: e.payers.map((p) => ({ memberId: String(p.memberId), amount: p.amount })),
    splits: e.splits.map(toLine),
    version: e.version ?? 1,
    createdByMemberId: String(e.createdByMemberId),
    updatedByMemberId: String(e.updatedByMemberId),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
}

type RevisionLike = { version: number; action: string; byMemberId: unknown; at: Date; snapshot: unknown };

export function toRevisionDTO(r: RevisionLike) {
  return { version: r.version, action: r.action, byMemberId: String(r.byMemberId), at: r.at, snapshot: r.snapshot };
}
