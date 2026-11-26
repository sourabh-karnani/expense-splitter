import { Schema, model } from 'mongoose';

export const SETTLEMENT_METHODS = ['cash', 'upi', 'bank', 'other'] as const;
export const SETTLEMENT_STATUSES = ['pending', 'confirmed', 'rejected'] as const;

// One real-world payment between two people. It has one leg per group it settles:
// a single-group settlement has one leg; a cross-group (pairwise netted) settlement has one leg per shared group.
// Legs are embedded so confirming the batch is a single atomic write. Only CONFIRMED legs count in balances.
const legSchema = new Schema(
  {
    groupId: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
    fromMemberId: { type: Schema.Types.ObjectId, ref: 'GroupMember', required: true },
    toMemberId: { type: Schema.Types.ObjectId, ref: 'GroupMember', required: true },
    amount: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const settlementSchema = new Schema(
  {
    // Accounts of the two people; absent when that side is a name-only member.
    fromUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    toUserId: { type: Schema.Types.ObjectId, ref: 'User' },
    createdByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    method: { type: String, enum: SETTLEMENT_METHODS, required: true },
    note: { type: String, default: '', maxlength: 200 },
    netAmount: { type: Number, required: true, min: 0 }, // what actually changes hands, from -> to
    status: { type: String, enum: SETTLEMENT_STATUSES, default: 'pending' },
    decidedAt: { type: Date, default: null },
    legs: { type: [legSchema], required: true },
    groupIds: { type: [Schema.Types.ObjectId], required: true }, // denormalised from legs for indexing
  },
  { timestamps: true },
);

settlementSchema.index({ groupIds: 1, status: 1, _id: -1 }); // a group's settlements; confirmed legs for balances
settlementSchema.index({ toUserId: 1, status: 1, _id: -1 }); // "waiting for me to confirm"

export const SettlementModel = model('Settlement', settlementSchema);

type LegLike = { groupId: unknown; fromMemberId: unknown; toMemberId: unknown; amount: number };
type SettlementLike = {
  _id: unknown;
  fromUserId?: unknown;
  toUserId?: unknown;
  createdByUserId: unknown;
  method: string;
  note?: string | null;
  netAmount: number;
  status: string;
  decidedAt?: Date | null;
  legs: LegLike[];
  createdAt?: Date;
};

export function toSettlementDTO(s: SettlementLike) {
  return {
    id: String(s._id),
    fromUserId: s.fromUserId ? String(s.fromUserId) : null,
    toUserId: s.toUserId ? String(s.toUserId) : null,
    createdByUserId: String(s.createdByUserId),
    method: s.method,
    note: s.note ?? '',
    netAmount: s.netAmount,
    status: s.status,
    decidedAt: s.decidedAt ?? null,
    legs: s.legs.map((l) => ({
      groupId: String(l.groupId),
      fromMemberId: String(l.fromMemberId),
      toMemberId: String(l.toMemberId),
      amount: l.amount,
    })),
    createdAt: s.createdAt,
  };
}
