import { Schema, model } from 'mongoose';

export const MAX_GROUP_MEMBERS = 20;
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

const groupSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    ownerUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    inviteCode: { type: String },
    inviteExpiresAt: { type: Date },
    // Kept in step with GroupMember rows by a conditional $inc, so the 20-member cap holds under concurrent joins.
    memberCount: { type: Number, default: 0, min: 0, max: MAX_GROUP_MEMBERS },
  },
  { timestamps: true },
);

groupSchema.index({ inviteCode: 1 }, { unique: true, sparse: true });

export const GroupModel = model('Group', groupSchema);

// A person in a group. userId is absent for a name-only member (added by a friend, no account yet).
// Payers, splits and settlements reference the member _id, so name-only members work everywhere.
const memberSchema = new Schema({
  groupId: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User' },
  displayName: { type: String, required: true, trim: true, maxlength: 80 },
  addedByUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  joinedAt: { type: Date, default: () => new Date() },
});

// One membership per account per group; name-only members have no userId and are not constrained.
memberSchema.index({ groupId: 1, userId: 1 }, { unique: true, partialFilterExpression: { userId: { $exists: true } } });
memberSchema.index({ userId: 1, _id: -1 }); // "my groups", newest first, cursor on _id
memberSchema.index({ groupId: 1, _id: 1 }); // members of a group in join order

export const GroupMemberModel = model('GroupMember', memberSchema);

type GroupLike = {
  _id: unknown;
  name: string;
  currency?: string | null;
  ownerUserId: unknown;
  memberCount?: number | null;
  inviteCode?: string | null;
  inviteExpiresAt?: Date | null;
  createdAt?: Date;
};

// The invite code is only included for the owner.
export function toGroupDTO(group: GroupLike, opts: { includeInvite?: boolean } = {}) {
  return {
    id: String(group._id),
    name: group.name,
    currency: group.currency ?? 'INR',
    ownerUserId: String(group.ownerUserId),
    memberCount: group.memberCount ?? 0,
    invite:
      opts.includeInvite && group.inviteCode
        ? { code: group.inviteCode, expiresAt: group.inviteExpiresAt ?? null }
        : null,
    createdAt: group.createdAt,
  };
}

type MemberLike = { _id: unknown; userId?: unknown; displayName: string; joinedAt?: Date | null };

export function toMemberDTO(member: MemberLike) {
  return {
    id: String(member._id),
    userId: member.userId ? String(member.userId) : null,
    displayName: member.displayName,
    isNameOnly: !member.userId,
    joinedAt: member.joinedAt ?? null,
  };
}
