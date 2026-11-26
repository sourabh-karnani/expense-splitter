# Trip expense splitter: plan

## Decisions
- **Database:** MongoDB only. The starter already runs on it (auth, tests, rules).
- **Atomic writes without transactions:** standalone MongoDB has no transactions, so every multi-part write is one document:
  - an expense holds its payers, splits and edit history;
  - a settlement batch holds its per-group entries.
- **Money:** integer paise, one currency per group (INR). Splits are rounded deterministically: leftover paise go to members in join order.
- **Split types:** `equal` (among the selected people), `exact`, `shares`. An expense can have **several payers**.
- **Members:** each group member has a `memberId`. Payers, splits and settlements refer to `memberId`, not `userId`, so name-only members (no account, added by a friend) work everywhere.
- **Group size:** at most 20 members, name-only members included.
- **Invite links:** `/j/<code>`. The code is 10 random base62 characters from `crypto` and expires after 24 hours. The group owner can regenerate it.
  - Joining requires login, and joining twice changes nothing.
  - Joining is rate-limited.
  - The group must have fewer than 20 members.
- **Edit:** any member can edit or delete an expense.
  - The edit sends the `version` it read, and the update only matches that version. If someone changed it in between, the server returns 409.
  - Every create, edit and delete adds a revision (a snapshot) inside the expense document.
  - Delete is soft (`deletedAt`).
- **Settlements:** a settlement is a **batch** of entries, one per group.
  - If the payer records it, it stays `pending` until the receiver confirms or rejects it.
  - If the receiver records it, it is confirmed immediately.
  - Only confirmed entries count toward balances.
  - Any amount up to what is owed is allowed (partial payments, cash).
- **Settling across groups:** this is pairwise only. Take the suggested payments between me and one other person in every group we share, and net them into **one** batch: one real transfer, one entry per group. The receiver confirms the whole batch at once.
- **Authorization:** access is by group membership. Anyone who isn't a member gets 404 for everything in that group. Payers, split participants and settlement parties must all be members of the group. *(This replaces the `ownerId` rule in CLAUDE.md for group data.)*

## Data model (Mongo)
```
Group         { name, currency:'INR', ownerUserId, inviteCode (unique, sparse), inviteExpiresAt, timestamps }
GroupMember   { groupId, userId? , displayName, addedByUserId, joinedAt }
                unique(groupId,userId) partial where userId exists; index(userId,_id); index(groupId,_id)
Expense       { groupId, title, description, amount, spentOn, splitType,
                payers:[{memberId, amount}], splits:[{memberId, shares?, amount}],
                version, createdBy, updatedBy, deletedAt,
                revisions:[{version, action:create|update|delete, byMemberId, at, snapshot}], timestamps }
                index(groupId, _id)
SettlementBatch { fromUserId?, toUserId?, createdByUserId, method:cash|upi|bank|other, note, netAmount,
                  status:pending|confirmed|rejected, decidedAt,
                  legs:[{groupId, fromMemberId, toMemberId, amount}], groupIds:[...], timestamps }
                index(groupIds, status); index(toUserId, status)
```

## Settle-up algorithm (`api/src/lib/settle.ts`, pure functions)
1. **`splitAmount`:** compute each person's share (equal, exact or shares) and hand out the leftover paise deterministically.
2. **`netBalances`:** for each member, what they paid − what they owe + confirmed payments they sent − confirmed payments they received. The balances add up to 0.
3. **`minimizePayments`:** produce the suggested payments.
   1. Drop members whose balance is 0.
   2. Match exact opposite amounts first: one full payment for each such pair.
   3. Run a bitmask DP over subsets that finds the largest number of disjoint groups of people whose balances sum to zero. The number of payments is (people left − number of groups), which is the minimum. With at most 20 members this is fast enough.
   4. Inside each group, the biggest debtor pays the biggest creditor until everyone is settled.
   5. Ties: among plans with the same number of payments, prefer the one where more debtors pay their whole debt in one payment.

## API
```
POST/GET  /api/groups                       GET /api/groups/:gid  (members + invite if owner)
POST      /api/groups/:gid/members          (add name-only member)
POST      /api/groups/:gid/invite           (owner: new 24h code)
GET/POST  /api/join/:code                   (preview / join)
GET/POST  /api/groups/:gid/expenses         PATCH/DELETE /api/groups/:gid/expenses/:eid
GET       /api/groups/:gid/expenses/:eid/history
GET       /api/groups/:gid/balances         → { balances, suggestedPayments }
POST      /api/groups/:gid/settlements      (one group, partial ok)
GET       /api/settlements?status=pending   (mine to confirm)
POST      /api/settlements/:id/confirm|reject (receiver only, conditional on status=pending)
GET/POST  /api/settle-with/:userId          (cross-group pairwise preview / create batch)
```

## API contract (frozen: B implements it, C calls it; types in `web/src/api.ts`)
All routes need login (`requireAuth`). The caller isn't a member of `:gid` → 404. Errors: `{ error: { message } }`.
Group-scoped ids (`memberId`, `eid`) that aren't in `:gid` → 400 in bodies, 404 in paths.

| Method & path | Body / query | Response |
|---|---|---|
| POST `/api/groups` | `{ name }` | 201 `GroupDetail`. The creator becomes the first member (displayName = user name), `memberCount` 1, and a 24h invite is created. |
| GET `/api/groups` | `?cursor&limit` (membership `_id` cursor) | `{ items: Group[], nextCursor }` |
| GET `/api/groups/:gid` | | `GroupDetail` = `{ group, members (join order), myMemberId }`. `group.invite` is only set for the owner. |
| POST `/api/groups/:gid/members` | `{ displayName }` | 201 `{ member }`. Adds a name-only member. 409 if the group already has 20. |
| POST `/api/groups/:gid/invite` | | Owner only (others get 403). 200 `{ invite }`: a new code valid for 24h; the old code stops working. |
| GET `/api/join/:code` | | `JoinPreview`. 404 if the code is unknown or expired. Rate-limited to 30 per 15 min. |
| POST `/api/join/:code` | `{ claimMemberId? }` | 200 `{ groupId }`. If already a member, nothing changes. `claimMemberId` takes over an unclaimed name-only member; otherwise a new member is added. 409 if full. |
| GET `/api/groups/:gid/expenses` | `?cursor&limit` | `{ items: Expense[], nextCursor }`, newest first, deleted ones excluded |
| GET `/api/groups/:gid/expenses/:eid` | | `{ expense }` |
| POST `/api/groups/:gid/expenses` | `ExpenseInput` | 201 `{ expense }`. Payers must sum to `amount`; splits are resolved by `splitAmount`. |
| PATCH `/api/groups/:gid/expenses/:eid` | `ExpenseInput & { version }` (full replacement) | `{ expense }`. 409 if the version is stale or `version >= 50`. |
| DELETE `/api/groups/:gid/expenses/:eid` | `?version=N` | 204, soft delete. 409 if the version is stale. |
| GET `/api/groups/:gid/expenses/:eid/history` | | `{ revisions: Revision[] }`, newest first. Deleted expenses' history is still readable. |
| GET `/api/groups/:gid/balances` | | `BalancesResponse` (balances in member join order) |
| POST `/api/groups/:gid/settlements` | `{ fromMemberId, toMemberId, amount, method, note? }` | 201 `{ settlement }`. Rules below. |
| GET `/api/groups/:gid/settlements` | `?cursor&limit` | `{ items: Settlement[], nextCursor }`, every status |
| GET `/api/settlements/pending` | | `{ items: Settlement[] }` where `toUserId` is me and the status is pending, max 50 |
| POST `/api/settlements/:id/confirm` and `/reject` | | `{ settlement }`. The update only matches `toUserId` = me and status pending; otherwise 404. |
| GET `/api/settle-with/:userId` | | `SettleWithPreview` across every group we both belong to. 404 if we share no group. |
| POST `/api/settle-with/:userId` | `{ method, note? }` | 201 `{ settlement }`. The legs are computed on the server. 400 if there's nothing to settle. |

**Single-group settlement rules:**
- `from` and `to` are members of `:gid`, and they're different people.
- `amount` is an integer from 1 up to what `from` owes, using confirmed balances.
- Who can record it:
  - the payer or the receiver;
  - any member, if neither side has an account.
- When it counts:
  - it's confirmed immediately if the recorder is the receiver, or if the receiver has no account (name-only);
  - otherwise it stays pending until the receiver confirms it.

**Cross-group settle:** for each group we share, compute `minimizePayments` and keep only the payments between my member and theirs. Then net them:
- `i_pay`: I'm `from`, and the settlement stays pending until they confirm.
- `they_pay`: I'm the receiver, so it's confirmed immediately.
- `even` (net 0): `to` is them, and it stays pending until they confirm.

## Build: who does what (separate files, no overlap)
| Step | Owner | Files |
|---|---|---|
| 0. Contract | main | models in `api/src/models/*`, DTOs, function signatures in `settle.ts`, types in `web/src/api.ts`, CLAUDE.md rule update |
| 1a. Algorithm | agent A | `api/src/lib/settle.ts`, `api/tests/settle.test.ts` |
| 1b. API | agent B | `api/src/routes/{groups,expenses,settlements}.ts`, `app.ts` mount, `api/tests/ledger.test.ts` |
| 1c. Web | agent C | `web/src/pages/{GroupsPage,GroupPage,ExpenseForm,JoinPage}.tsx`, `App.tsx` routes |
| 2. Integrate | main | review diffs, full typecheck + tests, run app, commit |

## Tests
- **Algorithm:**
  - the 5 scenarios;
  - multiple payers;
  - rounding;
  - a brute-force checker for up to 7 people that confirms the plan uses the minimum number of payments;
  - invariants: every balance ends at 0, at most n−1 payments.
- **API:**
  - create a group and join it by invite;
  - add a name-only member;
  - create an expense, edit it (history grows), delete it;
  - balances;
  - partial settlement: pending, then confirmed, then balances change;
  - netting across groups.
- **Security:**
  - a non-member gets 404 on the group, its expenses, balances and settlements;
  - a payer or split member from another group is rejected;
  - splits or payers that don't add up to the amount return 400;
  - unknown fields return 400;
  - an edit with an old version returns 409;
  - an expired, regenerated or invalid invite code is rejected;
  - the group cap of 20 is enforced;
  - only the receiver can confirm, and confirming twice doesn't count twice.
