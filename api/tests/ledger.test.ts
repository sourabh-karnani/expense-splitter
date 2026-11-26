import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createApp } from '../src/app.js';
import { connectDb, disconnectDb } from '../src/db.js';
import { env } from '../src/env.js';
import { UserModel } from '../src/models/User.js';
import { NoteModel } from '../src/models/Note.js';
import { GroupMemberModel, GroupModel } from '../src/models/Group.js';
import { ExpenseModel } from '../src/models/Expense.js';
import { SettlementModel } from '../src/models/Settlement.js';

// A fresh app per test keeps the global 300/min /api limiter from tripping. Sessions are JWT cookies, so they
// work across app instances. The register (20/15min) and join (30/15min) limiters are module-level: this file
// registers 6 users and makes ~25 join calls in total.
let app = createApp();
beforeEach(() => {
  app = createApp();
});

beforeAll(async () => {
  if (!env.MONGO_URL.includes('_test')) throw new Error('Refusing to run tests against a non-test database');
  await connectDb(env.MONGO_URL);
  await mongoose.connection.dropDatabase();
  await Promise.all([
    UserModel.init(),
    NoteModel.init(),
    GroupModel.init(),
    GroupMemberModel.init(),
    ExpenseModel.init(),
    SettlementModel.init(),
  ]);
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDb();
});

type Client = ReturnType<typeof clientFor>;

function clientFor(cookie: string, id: string, name: string) {
  return {
    id,
    name,
    get: (path: string) => request(app).get(path).set('Cookie', cookie),
    post: (path: string, body: object = {}) => request(app).post(path).set('Cookie', cookie).send(body),
    patch: (path: string, body: object) => request(app).patch(path).set('Cookie', cookie).send(body),
    del: (path: string) => request(app).delete(path).set('Cookie', cookie),
  };
}

async function signUp(name: string): Promise<Client> {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ email: `${name.toLowerCase()}@ledger.test`, name, password: 'correct-horse-battery' })
    .expect(201);
  const cookie = String(res.headers['set-cookie'][0]).split(';')[0];
  return clientFor(cookie, res.body.user.id, name);
}

async function createGroup(owner: Client, name: string) {
  const res = await owner.post('/api/groups', { name }).expect(201);
  return res.body as { group: { id: string; invite: { code: string } }; myMemberId: string };
}

function join(user: Client, code: string, body: object = {}) {
  return user.post(`/api/join/${code}`, body);
}

async function memberIdOf(user: Client, gid: string) {
  const res = await user.get(`/api/groups/${gid}`).expect(200);
  return res.body.myMemberId as string;
}

async function balancesOf(user: Client, gid: string) {
  const res = await user.get(`/api/groups/${gid}/balances`).expect(200);
  return Object.fromEntries(res.body.balances.map((b: { memberId: string; amount: number }) => [b.memberId, b.amount]));
}

function equalExpense(title: string, amount: number, payer: string, among: string[]) {
  return {
    title,
    amount,
    splitType: 'equal',
    payers: [{ memberId: payer, amount }],
    splits: among.map((memberId) => ({ memberId })),
  };
}

let alice: Client, bob: Client, carol: Client, dave: Client, eve: Client, frank: Client;

beforeAll(async () => {
  alice = await signUp('Alice');
  bob = await signUp('Bob');
  carol = await signUp('Carol');
  dave = await signUp('Dave');
  eve = await signUp('Eve'); // never joins the main groups: the outsider
  frank = await signUp('Frank');
});

describe('groups and invites', () => {
  let gid: string;
  let code: string;

  it('creates a group and joins by invite; joining twice changes nothing', async () => {
    const created = await createGroup(alice, 'Goa trip');
    gid = created.group.id;
    code = created.group.invite.code;
    expect(code).toMatch(/^[A-Za-z0-9]{10}$/);

    const preview = await bob.get(`/api/join/${code}`).expect(200);
    expect(preview.body).toMatchObject({ group: { id: gid, name: 'Goa trip', memberCount: 1 }, alreadyMember: false });

    expect((await join(bob, code).expect(200)).body).toEqual({ groupId: gid });
    await join(bob, code).expect(200);

    const detail = await alice.get(`/api/groups/${gid}`).expect(200);
    expect(detail.body.group.memberCount).toBe(2);
    expect(detail.body.members.map((m: { displayName: string }) => m.displayName)).toEqual(['Alice', 'Bob']);
    expect(detail.body.group.invite.code).toBe(code);

    // The invite is only shown to the owner.
    const asBob = await bob.get(`/api/groups/${gid}`).expect(200);
    expect(asBob.body.group.invite).toBeNull();
    const bobList = await bob.get('/api/groups').expect(200);
    expect(bobList.body.items.map((g: { id: string }) => g.id)).toContain(gid);
    expect(bobList.body.items[0].invite).toBeNull();
  });

  it('adds a name-only member and lets a new user claim it', async () => {
    const added = await alice.post(`/api/groups/${gid}/members`, { displayName: 'Zed' }).expect(201);
    const zedId = added.body.member.id;
    expect(added.body.member).toMatchObject({ userId: null, isNameOnly: true });

    const preview = await carol.get(`/api/join/${code}`).expect(200);
    expect(preview.body.nameOnlyMembers).toEqual([{ id: zedId, displayName: 'Zed' }]);

    await join(carol, code, { claimMemberId: zedId }).expect(200);
    const detail = await alice.get(`/api/groups/${gid}`).expect(200);
    const zed = detail.body.members.find((m: { id: string }) => m.id === zedId);
    expect(zed).toMatchObject({ userId: carol.id, displayName: 'Carol', isNameOnly: false });
    expect(detail.body.group.memberCount).toBe(3); // claiming doesn't add a seat

    // Already claimed → 409, and Dave did not become a member.
    await join(dave, code, { claimMemberId: zedId }).expect(409);
    await dave.get(`/api/groups/${gid}`).expect(404);
  });

  it('rejects invalid, regenerated and expired codes; only the owner regenerates', async () => {
    await dave.get('/api/join/short').expect(404);
    await dave.get('/api/join/AAAAAAAAAA').expect(404);
    // A query-operator object can't reach the query: path params are strings and the format is checked.
    await dave.get(`/api/join/${encodeURIComponent('{"$ne":null}')}`).expect(404);

    await bob.post(`/api/groups/${gid}/invite`).expect(403);
    const regenerated = await alice.post(`/api/groups/${gid}/invite`).expect(200);
    const newCode = regenerated.body.invite.code;
    expect(newCode).not.toBe(code);
    await dave.get(`/api/join/${code}`).expect(404);
    await dave.get(`/api/join/${newCode}`).expect(200);

    await GroupModel.updateOne({ _id: gid }, { $set: { inviteExpiresAt: new Date(Date.now() - 1000) } });
    await dave.get(`/api/join/${newCode}`).expect(404);
    await join(dave, newCode).expect(404);
  });

  it('caps a group at 20 members, name-only included', async () => {
    const created = await createGroup(alice, 'Big group');
    const big = created.group.id;
    for (let i = 1; i <= 19; i++) {
      await alice.post(`/api/groups/${big}/members`, { displayName: `Friend ${i}` }).expect(201);
    }
    await alice.post(`/api/groups/${big}/members`, { displayName: 'One too many' }).expect(409);
    await join(bob, created.group.invite.code).expect(409);
    // Operator objects in the join body are rejected by validation.
    await join(bob, created.group.invite.code, { claimMemberId: { $exists: false } }).expect(400);

    const detail = await alice.get(`/api/groups/${big}`).expect(200);
    expect(detail.body.group.memberCount).toBe(20);
    expect(detail.body.members).toHaveLength(20);
  });
});

// Trip group used by the expense and security tests: Alice, Bob, Carol + name-only Nina.
let trip: string;
let aM: string, bM: string, cM: string, nM: string;

describe('expenses', () => {
  beforeAll(async () => {
    const created = await createGroup(alice, 'Trip');
    trip = created.group.id;
    aM = created.myMemberId;
    await join(bob, created.group.invite.code).expect(200);
    await join(carol, created.group.invite.code).expect(200);
    bM = await memberIdOf(bob, trip);
    cM = await memberIdOf(carol, trip);
    nM = (await alice.post(`/api/groups/${trip}/members`, { displayName: 'Nina' }).expect(201)).body.member.id;
  });

  it('creates equal (subset), shares and exact expenses with multiple payers', async () => {
    // Equal among a subset, given out of order: leftover paisa goes to the earliest joiner (Alice).
    const equal = await alice.post(`/api/groups/${trip}/expenses`, equalExpense('Taxi', 1000, aM, [cM, aM, bM])).expect(201);
    expect(equal.body.expense.splits).toEqual([
      { memberId: aM, amount: 334 },
      { memberId: bM, amount: 333 },
      { memberId: cM, amount: 333 },
    ]);
    expect(equal.body.expense.version).toBe(1);
    expect(equal.body.expense.spentOn.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));

    const shares = await bob
      .post(`/api/groups/${trip}/expenses`, {
        title: 'Hotel',
        amount: 900,
        spentOn: '2026-11-20',
        splitType: 'shares',
        payers: [
          { memberId: aM, amount: 600 },
          { memberId: bM, amount: 300 },
        ],
        splits: [
          { memberId: nM, shares: 2 },
          { memberId: aM, shares: 1 },
        ],
      })
      .expect(201);
    expect(shares.body.expense.splits).toEqual([
      { memberId: aM, shares: 1, amount: 300 },
      { memberId: nM, shares: 2, amount: 600 },
    ]);
    expect(shares.body.expense.payers).toHaveLength(2);

    const exact = await carol
      .post(`/api/groups/${trip}/expenses`, {
        title: 'Snacks',
        amount: 500,
        splitType: 'exact',
        payers: [{ memberId: cM, amount: 500 }],
        splits: [
          { memberId: aM, amount: 200 },
          { memberId: cM, amount: 300 },
        ],
      })
      .expect(201);
    expect(exact.body.expense.createdByMemberId).toBe(cM);
  });

  it('lists newest first with cursor pagination', async () => {
    const first = await bob.get(`/api/groups/${trip}/expenses?limit=2`).expect(200);
    expect(first.body.items.map((e: { title: string }) => e.title)).toEqual(['Snacks', 'Hotel']);
    const second = await bob.get(`/api/groups/${trip}/expenses?limit=2&cursor=${first.body.nextCursor}`).expect(200);
    expect(second.body.items.map((e: { title: string }) => e.title)).toEqual(['Taxi']);
    expect(second.body.nextCursor).toBeNull();
  });

  it('edits with a version check, keeps history, and soft-deletes', async () => {
    const before = await balancesOf(alice, trip);
    const body = equalExpense('Lunch', 600, bM, [aM, bM]);
    const created = await bob.post(`/api/groups/${trip}/expenses`, body).expect(201);
    const eid = created.body.expense.id;

    const edited = await carol
      .patch(`/api/groups/${trip}/expenses/${eid}`, { ...body, title: 'Lunch (edited)', amount: 800, payers: [{ memberId: bM, amount: 800 }], version: 1 })
      .expect(200);
    expect(edited.body.expense).toMatchObject({ title: 'Lunch (edited)', amount: 800, version: 2, updatedByMemberId: cM });

    // Stale version → 409.
    await alice.patch(`/api/groups/${trip}/expenses/${eid}`, { ...body, version: 1 }).expect(409);

    let history = await alice.get(`/api/groups/${trip}/expenses/${eid}/history`).expect(200);
    expect(history.body.revisions.map((r: { action: string; version: number }) => [r.action, r.version])).toEqual([
      ['update', 2],
      ['create', 1],
    ]);
    expect(history.body.revisions[0].snapshot.title).toBe('Lunch (edited)');

    await alice.del(`/api/groups/${trip}/expenses/${eid}?version=1`).expect(409);
    await alice.del(`/api/groups/${trip}/expenses/${eid}?version=2`).expect(204);

    history = await alice.get(`/api/groups/${trip}/expenses/${eid}/history`).expect(200);
    expect(history.body.revisions.map((r: { action: string }) => r.action)).toEqual(['delete', 'update', 'create']);
    expect(history.body.revisions[0].snapshot.amount).toBe(800);

    await alice.get(`/api/groups/${trip}/expenses/${eid}`).expect(404);
    await alice.patch(`/api/groups/${trip}/expenses/${eid}`, { ...body, version: 3 }).expect(404);

    // Edit cap: an expense at version 50 can't be edited any more.
    const capped = await bob.post(`/api/groups/${trip}/expenses`, body).expect(201);
    await ExpenseModel.updateOne({ _id: capped.body.expense.id }, { $set: { version: 50 } });
    await bob.patch(`/api/groups/${trip}/expenses/${capped.body.expense.id}`, { ...body, version: 50 }).expect(409);
    await bob.del(`/api/groups/${trip}/expenses/${capped.body.expense.id}?version=50`).expect(204);
    const list = await alice.get(`/api/groups/${trip}/expenses`).expect(200);
    expect(list.body.items.map((e: { id: string }) => e.id)).not.toContain(eid);
    expect(await balancesOf(alice, trip)).toEqual(before); // the deleted expense no longer counts
  });
});

describe('balances and single-group settlements', () => {
  let gid: string;
  let a: string, b: string, c: string;

  beforeAll(async () => {
    const created = await createGroup(alice, 'Dinner club');
    gid = created.group.id;
    a = created.myMemberId;
    await join(bob, created.group.invite.code).expect(200);
    await join(carol, created.group.invite.code).expect(200);
    b = await memberIdOf(bob, gid);
    c = await memberIdOf(carol, gid);
    // Alice pays 3000 for dinner, split equally: Bob and Carol owe her 1000 each.
    await alice.post(`/api/groups/${gid}/expenses`, equalExpense('Dinner', 3000, a, [a, b, c])).expect(201);
  });

  it('shows balances in join order and the suggested payments', async () => {
    const res = await bob.get(`/api/groups/${gid}/balances`).expect(200);
    expect(res.body.balances).toEqual([
      { memberId: a, displayName: 'Alice', amount: 2000 },
      { memberId: b, displayName: 'Bob', amount: -1000 },
      { memberId: c, displayName: 'Carol', amount: -1000 },
    ]);
    expect(res.body.suggestedPayments).toHaveLength(2);
    expect(res.body.suggestedPayments).toEqual(
      expect.arrayContaining([
        { fromMemberId: b, toMemberId: a, amount: 1000 },
        { fromMemberId: c, toMemberId: a, amount: 1000 },
      ]),
    );
  });

  it('keeps a payer-recorded partial payment pending until the receiver confirms, once', async () => {
    const created = await bob
      .post(`/api/groups/${gid}/settlements`, { fromMemberId: b, toMemberId: a, amount: 500, method: 'cash' })
      .expect(201);
    const sid = created.body.settlement.id;
    expect(created.body.settlement).toMatchObject({ status: 'pending', fromUserId: bob.id, toUserId: alice.id, netAmount: 500 });
    expect((await balancesOf(alice, gid))[b]).toBe(-1000); // pending doesn't count

    const pending = await alice.get('/api/settlements/pending').expect(200);
    expect(pending.body.items.map((s: { id: string }) => s.id)).toContain(sid);

    await carol.post(`/api/settlements/${sid}/confirm`).expect(404); // not the receiver
    await bob.post(`/api/settlements/${sid}/confirm`).expect(404); // the payer can't confirm either
    const confirmed = await alice.post(`/api/settlements/${sid}/confirm`).expect(200);
    expect(confirmed.body.settlement.status).toBe('confirmed');
    await alice.post(`/api/settlements/${sid}/confirm`).expect(404); // twice → 404

    const after = await balancesOf(alice, gid);
    expect(after[b]).toBe(-500); // counted once
    expect(after[a]).toBe(1500);

    // Uppercase ids reach the same group; balances must still count the confirmed leg, so the cap holds.
    expect(await balancesOf(alice, gid.toUpperCase())).toEqual(after);
    await bob
      .post(`/api/groups/${gid.toUpperCase()}/settlements`, { fromMemberId: b.toUpperCase(), toMemberId: a, amount: 501, method: 'cash' })
      .expect(400);
  });

  it('auto-confirms when the receiver records it; a rejected one never counts', async () => {
    const res = await alice
      .post(`/api/groups/${gid}/settlements`, { fromMemberId: c, toMemberId: a, amount: 400, method: 'upi', note: 'GPay' })
      .expect(201);
    expect(res.body.settlement.status).toBe('confirmed');
    expect((await balancesOf(alice, gid))[c]).toBe(-600);

    const pending = await carol
      .post(`/api/groups/${gid}/settlements`, { fromMemberId: c, toMemberId: a, amount: 100, method: 'cash' })
      .expect(201);
    const rejected = await alice.post(`/api/settlements/${pending.body.settlement.id}/reject`).expect(200);
    expect(rejected.body.settlement.status).toBe('rejected');
    expect((await balancesOf(alice, gid))[c]).toBe(-600);

    const list = await bob.get(`/api/groups/${gid}/settlements`).expect(200);
    expect(list.body.items.map((s: { status: string }) => s.status)).toEqual(['rejected', 'confirmed', 'confirmed']);
  });

  it('rejects amounts above the debt, third-party recorders and bad bodies', async () => {
    const base = { fromMemberId: b, toMemberId: a, method: 'cash' };
    await bob.post(`/api/groups/${gid}/settlements`, { ...base, amount: 501 }).expect(400); // Bob owes 500
    await alice.post(`/api/groups/${gid}/settlements`, { ...base, fromMemberId: a, toMemberId: b, amount: 1 }).expect(400); // Alice owes nothing
    // Decision: a third member recording a payment between two account holders gets 403 (valid body,
    // but the caller has no right to act for either side).
    await carol.post(`/api/groups/${gid}/settlements`, { ...base, amount: 100 }).expect(403);
    await bob.post(`/api/groups/${gid}/settlements`, { ...base, toMemberId: b, amount: 100 }).expect(400);
    await bob.post(`/api/groups/${gid}/settlements`, { ...base, amount: 12.5 }).expect(400);
    await bob.post(`/api/groups/${gid}/settlements`, { ...base, amount: 100, status: 'confirmed' }).expect(400);
    await bob.post(`/api/groups/${gid}/settlements`, { ...base, toMemberId: { $ne: null }, amount: 100 }).expect(400);
    await bob.post(`/api/groups/${gid}/settlements`, { ...base, toMemberId: aM, amount: 100 }).expect(400); // other group's member
  });
});

describe('settle-with across groups', () => {
  let g2: string, g3: string;

  beforeAll(async () => {
    // Goa: Dave pays 1000 split with Frank → Frank owes Dave 500.
    const goa = await createGroup(dave, 'Goa');
    g2 = goa.group.id;
    await join(frank, goa.group.invite.code).expect(200);
    const fInG2 = await memberIdOf(frank, g2);
    await dave.post(`/api/groups/${g2}/expenses`, equalExpense('Villa', 1000, goa.myMemberId, [goa.myMemberId, fInG2])).expect(201);

    // Manali: Frank pays 300 split with Dave → Dave owes Frank 150.
    const manali = await createGroup(frank, 'Manali');
    g3 = manali.group.id;
    await join(dave, manali.group.invite.code).expect(200);
    const dInG3 = await memberIdOf(dave, g3);
    await frank.post(`/api/groups/${g3}/expenses`, equalExpense('Cab', 300, manali.myMemberId, [manali.myMemberId, dInG3])).expect(201);
  });

  it('nets both groups into one batch and confirming zeroes the pair everywhere', async () => {
    const preview = await frank.get(`/api/settle-with/${dave.id}`).expect(200);
    expect(preview.body).toMatchObject({ otherUser: { id: dave.id, name: 'Dave' }, direction: 'i_pay', netAmount: 350 });
    expect(preview.body.legs.map((l: { groupName: string; amount: number }) => [l.groupName, l.amount]).sort()).toEqual([
      ['Goa', 500],
      ['Manali', 150],
    ]);
    const theirView = await dave.get(`/api/settle-with/${frank.id}`).expect(200);
    expect(theirView.body).toMatchObject({ direction: 'they_pay', netAmount: 350 });

    // The client never sends legs.
    await frank.post(`/api/settle-with/${dave.id}`, { method: 'upi', legs: [] }).expect(400);
    const created = await frank.post(`/api/settle-with/${dave.id}`, { method: 'upi' }).expect(201);
    expect(created.body.settlement).toMatchObject({ status: 'pending', fromUserId: frank.id, toUserId: dave.id, netAmount: 350 });
    expect(created.body.settlement.legs).toHaveLength(2);

    await dave.post(`/api/settlements/${created.body.settlement.id}/confirm`).expect(200);
    expect(Object.values(await balancesOf(dave, g2))).toEqual([0, 0]);
    expect(Object.values(await balancesOf(dave, g3))).toEqual([0, 0]);

    const after = await frank.get(`/api/settle-with/${dave.id}`).expect(200);
    expect(after.body).toMatchObject({ legs: [], direction: 'even', netAmount: 0 });
    await frank.post(`/api/settle-with/${dave.id}`, { method: 'cash' }).expect(400); // nothing to settle
  });

  it('404s without a shared group, for yourself, and for malformed ids', async () => {
    await eve.get(`/api/settle-with/${dave.id}`).expect(404);
    await dave.get(`/api/settle-with/${dave.id}`).expect(404);
    await dave.get('/api/settle-with/not-an-id').expect(404);
  });
});

describe('security', () => {
  let eid: string;

  beforeAll(async () => {
    const res = await alice.post(`/api/groups/${trip}/expenses`, equalExpense('Fuel', 900, aM, [aM, bM, cM])).expect(201);
    eid = res.body.expense.id;
  });

  it('returns 404 for everything in a group to a non-member', async () => {
    const body = { ...equalExpense('Hack', 100, aM, [aM]), version: 1 };
    await eve.get(`/api/groups/${trip}`).expect(404);
    await eve.get(`/api/groups/${trip}/expenses`).expect(404);
    await eve.get(`/api/groups/${trip}/expenses/${eid}`).expect(404);
    await eve.get(`/api/groups/${trip}/expenses/${eid}/history`).expect(404);
    await eve.get(`/api/groups/${trip}/balances`).expect(404);
    await eve.get(`/api/groups/${trip}/settlements`).expect(404);
    await eve.patch(`/api/groups/${trip}/expenses/${eid}`, body).expect(404);
    await eve.del(`/api/groups/${trip}/expenses/${eid}?version=1`).expect(404);
    await eve.post(`/api/groups/${trip}/expenses`, equalExpense('Hack', 100, aM, [aM])).expect(404);
    await eve.post(`/api/groups/${trip}/members`, { displayName: 'Mallory' }).expect(404);
    await eve.post(`/api/groups/${trip}/invite`).expect(404);
    await eve.post(`/api/groups/${trip}/settlements`, { fromMemberId: bM, toMemberId: aM, amount: 1, method: 'cash' }).expect(404);
    await request(app).get(`/api/groups/${trip}`).expect(401);
    // The expense is untouched.
    expect((await alice.get(`/api/groups/${trip}/expenses/${eid}`).expect(200)).body.expense.version).toBe(1);
  });

  it('rejects bad expense bodies with 400', async () => {
    const other = await createGroup(eve, 'Eve only');
    const outsider = other.myMemberId;
    const url = `/api/groups/${trip}/expenses`;
    const ok = equalExpense('Ok', 900, aM, [aM, bM]);

    await alice.post(url, { ...ok, payers: [{ memberId: outsider, amount: 900 }] }).expect(400);
    await alice.post(url, { ...ok, splits: [{ memberId: aM }, { memberId: outsider }] }).expect(400);
    await alice.post(url, { ...ok, payers: [{ memberId: aM, amount: 800 }] }).expect(400); // payers ≠ amount
    await alice.post(url, { ...ok, payers: [{ memberId: aM, amount: 450 }, { memberId: aM, amount: 450 }] }).expect(400); // duplicate payer
    await alice
      .post(url, { ...ok, splitType: 'exact', splits: [{ memberId: aM, amount: 400 }, { memberId: bM, amount: 400 }] })
      .expect(400); // exact ≠ amount
    await alice.post(url, { ...ok, version: 3 }).expect(400); // unknown field
    await alice.post(url, { ...ok, createdByMemberId: bM }).expect(400);
    await alice.post(url, { ...ok, amount: 12.5, payers: [{ memberId: aM, amount: 12.5 }] }).expect(400);
    await alice.post(url, { ...ok, payers: [{ memberId: { $ne: null }, amount: 900 }] }).expect(400);
    await alice.get(`/api/groups/${trip}/expenses?cursor[$gt]=0`).expect(200); // ignored, not an operator
    await alice.get(`/api/groups/${trip}/expenses/${eid}/history`).expect(200);
    await alice.get(`/api/groups/${trip}/expenses/not-an-id`).expect(404);
    await alice.get(`/api/groups/${other.group.id}`).expect(404);
  });
});
