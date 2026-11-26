// Pure money logic: no database, no app.
import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/lib/httpError.js';
import {
  minimizePayments,
  netBalances,
  splitAmount,
  type Balances,
  type SplitInput,
  type SplitType,
  type Transfer,
} from '../src/lib/settle.js';

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
  return undefined;
}

function apply(balances: Balances, payments: Transfer[]): Balances {
  const out = { ...balances };
  for (const p of payments) {
    out[p.fromMemberId] += p.amount; // debtor (negative) pays, moves toward 0
    out[p.toMemberId] -= p.amount;
  }
  return out;
}

function expectSettled(balances: Balances, payments: Transfer[]) {
  for (const v of Object.values(apply(balances, payments))) expect(v).toBe(0);
  for (const p of payments) {
    expect(Number.isInteger(p.amount)).toBe(true);
    expect(p.amount).toBeGreaterThan(0);
    expect(p.fromMemberId).not.toBe(p.toMemberId);
  }
}

/** Plain greedy (largest debtor pays largest creditor) over everyone, no pairing or DP. */
function greedyCount(balances: Balances): number {
  const e = Object.entries(balances).map(([id, bal]) => ({ id, bal }));
  let count = 0;
  for (;;) {
    const d = e.filter((x) => x.bal < 0).sort((a, b) => a.bal - b.bal || (a.id < b.id ? -1 : 1))[0];
    const c = e.filter((x) => x.bal > 0).sort((a, b) => b.bal - a.bal || (a.id < b.id ? -1 : 1))[0];
    if (!d || !c) return count;
    const amt = Math.min(-d.bal, c.bal);
    d.bal += amt;
    c.bal -= amt;
    count++;
  }
}

/** Brute force: max number of disjoint zero-sum groups partitioning `vals` (which sum to 0). */
function bruteMaxGroups(vals: number[]): number {
  if (vals.length === 0) return 0;
  const [first, ...rest] = vals;
  let best = 0;
  // every subset of `rest` joined with `first` that sums to 0 is a candidate first group
  for (let mask = 0; mask < 1 << rest.length; mask++) {
    let s = first;
    const remaining: number[] = [];
    rest.forEach((v, i) => ((mask >> i) & 1 ? (s += v) : remaining.push(v)));
    if (s === 0) best = Math.max(best, 1 + bruteMaxGroups(remaining));
  }
  return best;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('splitAmount', () => {
  it('equal split of a dinner among 5', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const lines = splitAmount(100000, 'equal', ids.map((memberId) => ({ memberId })));
    expect(lines).toStrictEqual(ids.map((memberId) => ({ memberId, amount: 20000 })));
  });

  it('rounding: ₹100 split 3 ways is 3334/3333/3333', () => {
    const lines = splitAmount(10000, 'equal', [{ memberId: 'x' }, { memberId: 'y' }, { memberId: 'z' }]);
    expect(lines).toStrictEqual([
      { memberId: 'x', amount: 3334 },
      { memberId: 'y', amount: 3333 },
      { memberId: 'z', amount: 3333 },
    ]);
  });

  it('uneven shares 2/2/3 for a ₹9000 hotel, leftover paise in order', () => {
    const lines = splitAmount(900000, 'shares', [
      { memberId: 'a', shares: 2 },
      { memberId: 'b', shares: 2 },
      { memberId: 'c', shares: 3 },
    ]);
    // floors 257142 + 257142 + 385714 = 899998, so a and b get +1
    expect(lines).toStrictEqual([
      { memberId: 'a', shares: 2, amount: 257143 },
      { memberId: 'b', shares: 2, amount: 257143 },
      { memberId: 'c', shares: 3, amount: 385714 },
    ]);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(900000);
  });

  it('shares with large values stays exact', () => {
    const lines = splitAmount(1_000_000_000, 'shares', [
      { memberId: 'a', shares: 1000 },
      { memberId: 'b', shares: 999 },
      { memberId: 'c', shares: 1 },
    ]);
    expect(lines.reduce((s, l) => s + l.amount, 0)).toBe(1_000_000_000);
    expect(lines.map((l) => l.amount)).toStrictEqual([500000000, 499500000, 500000]);
  });

  it('exact split keeps amounts and has no shares key', () => {
    const lines = splitAmount(500, 'exact', [
      { memberId: 'a', amount: 300 },
      { memberId: 'b', amount: 0 },
      { memberId: 'c', amount: 200 },
    ]);
    expect(lines).toStrictEqual([
      { memberId: 'a', amount: 300 },
      { memberId: 'b', amount: 0 },
      { memberId: 'c', amount: 200 },
    ]);
  });

  const bad: [string, number, SplitType, SplitInput[]][] = [
    ['no participants', 100, 'equal', []],
    ['zero total', 0, 'equal', [{ memberId: 'a' }]],
    ['negative total', -5, 'equal', [{ memberId: 'a' }]],
    ['fractional total', 10.5, 'equal', [{ memberId: 'a' }]],
    ['duplicate member', 100, 'equal', [{ memberId: 'a' }, { memberId: 'a' }]],
    ['equal with shares', 100, 'equal', [{ memberId: 'a', shares: 1 }]],
    ['equal with amount', 100, 'equal', [{ memberId: 'a', amount: 100 }]],
    ['exact missing amount', 100, 'exact', [{ memberId: 'a', amount: 100 }, { memberId: 'b' }]],
    ['exact negative amount', 100, 'exact', [{ memberId: 'a', amount: 110 }, { memberId: 'b', amount: -10 }]],
    ['exact fractional amount', 100, 'exact', [{ memberId: 'a', amount: 50.5 }, { memberId: 'b', amount: 49.5 }]],
    ['exact with shares', 100, 'exact', [{ memberId: 'a', amount: 100, shares: 1 }]],
    ['exact bad sum', 100, 'exact', [{ memberId: 'a', amount: 60 }, { memberId: 'b', amount: 30 }]],
    ['shares missing', 100, 'shares', [{ memberId: 'a', shares: 1 }, { memberId: 'b' }]],
    ['shares zero', 100, 'shares', [{ memberId: 'a', shares: 0 }]],
    ['shares fractional', 100, 'shares', [{ memberId: 'a', shares: 1.5 }]],
    ['shares with amount', 100, 'shares', [{ memberId: 'a', shares: 1, amount: 100 }]],
  ];
  it.each(bad)('400 on %s', (_name, total, type, parts) => {
    expect(statusOf(() => splitAmount(total, type, parts))).toBe(400);
  });
});

describe('netBalances', () => {
  const five = ['a', 'b', 'c', 'd', 'e'];

  it('dinner: one payer, equal split among 5', () => {
    const splits = splitAmount(100000, 'equal', five.map((memberId) => ({ memberId })));
    const b = netBalances(five, [{ payers: [{ memberId: 'a', amount: 100000 }], splits }], []);
    expect(b).toStrictEqual({ a: 80000, b: -20000, c: -20000, d: -20000, e: -20000 });
    expect(minimizePayments(b)).toHaveLength(4);
  });

  it('subset: concert for 4 of 5, the 5th stays at 0', () => {
    const splits = splitAmount(400000, 'equal', ['a', 'b', 'c', 'd'].map((memberId) => ({ memberId })));
    const b = netBalances(five, [{ payers: [{ memberId: 'b', amount: 400000 }], splits }], []);
    expect(b).toStrictEqual({ a: -100000, b: 300000, c: -100000, d: -100000, e: 0 });
  });

  it('multiple payers: 6000 + 3000', () => {
    const splits = splitAmount(9000, 'equal', ['a', 'b', 'c'].map((memberId) => ({ memberId })));
    const b = netBalances(
      ['a', 'b', 'c'],
      [{ payers: [{ memberId: 'a', amount: 6000 }, { memberId: 'b', amount: 3000 }], splits }],
      [],
    );
    expect(b).toStrictEqual({ a: 3000, b: 0, c: -3000 });
    expect(minimizePayments(b)).toStrictEqual([{ fromMemberId: 'c', toMemberId: 'a', amount: 3000 }]);
  });

  it('partial cash payment reduces the debt', () => {
    const splits = splitAmount(10000, 'equal', [{ memberId: 'a' }, { memberId: 'b' }]);
    const exp = [{ payers: [{ memberId: 'a', amount: 10000 }], splits }];
    const b = netBalances(['a', 'b'], exp, [{ fromMemberId: 'b', toMemberId: 'a', amount: 2000 }]);
    expect(b).toStrictEqual({ a: 3000, b: -3000 });
    expect(minimizePayments(b)).toStrictEqual([{ fromMemberId: 'b', toMemberId: 'a', amount: 3000 }]);
  });

  it('includes untouched members and sums to 0', () => {
    const b = netBalances(['a', 'b', 'z'], [], [{ fromMemberId: 'a', toMemberId: 'b', amount: 5 }]);
    expect(b).toStrictEqual({ a: 5, b: -5, z: 0 });
  });

  it('500 on ids outside memberIds', () => {
    const exp = [{ payers: [{ memberId: 'x', amount: 10 }], splits: [{ memberId: 'a', amount: 10 }] }];
    expect(statusOf(() => netBalances(['a'], exp, []))).toBe(500);
    const exp2 = [{ payers: [{ memberId: 'a', amount: 10 }], splits: [{ memberId: 'x', amount: 10 }] }];
    expect(statusOf(() => netBalances(['a'], exp2, []))).toBe(500);
    expect(statusOf(() => netBalances(['a'], [], [{ fromMemberId: 'a', toMemberId: 'x', amount: 1 }]))).toBe(500);
  });
});

describe('minimizePayments', () => {
  it('exact-match pair is one full payment', () => {
    const b = { a: -500, b: 500, c: 0 };
    expect(minimizePayments(b)).toStrictEqual([{ fromMemberId: 'a', toMemberId: 'b', amount: 500 }]);
  });

  it('returns nothing when everyone is settled', () => {
    expect(minimizePayments({ a: 0, b: 0 })).toStrictEqual([]);
    expect(minimizePayments({})).toStrictEqual([]);
  });

  it('500 when balances do not sum to 0', () => {
    expect(statusOf(() => minimizePayments({ a: 5, b: -4 }))).toBe(500);
  });

  it('beats greedy via exact pairs: {a:-7,b:-3,c:-4,d:+5,e:+5,f:+4}', () => {
    const b = { a: -7, b: -3, c: -4, d: 5, e: 5, f: 4 };
    expect(greedyCount(b)).toBe(5);
    const pays = minimizePayments(b);
    expectSettled(b, pays);
    expect(pays).toHaveLength(4);
    expect(pays).toContainEqual({ fromMemberId: 'c', toMemberId: 'f', amount: 4 });
  });

  it('beats greedy via the DP (no exact pairs): {a:-8,b:-6,c:-4,d:-1,e:+10,f:+9}', () => {
    const b = { a: -8, b: -6, c: -4, d: -1, e: 10, f: 9 };
    expect(greedyCount(b)).toBe(5);
    const pays = minimizePayments(b);
    expectSettled(b, pays);
    // groups {b,c,e} and {a,d,f}
    expect(pays).toStrictEqual([
      { fromMemberId: 'a', toMemberId: 'f', amount: 8 },
      { fromMemberId: 'b', toMemberId: 'e', amount: 6 },
      { fromMemberId: 'c', toMemberId: 'e', amount: 4 },
      { fromMemberId: 'd', toMemberId: 'f', amount: 1 },
    ]);
  });

  it('is deterministic regardless of key order', () => {
    const b1 = { a: -8, b: -6, c: -4, d: -1, e: 10, f: 9 };
    const b2 = { f: 9, d: -1, e: 10, a: -8, c: -4, b: -6 };
    expect(minimizePayments(b2)).toStrictEqual(minimizePayments(b1));
  });

  it('property: 200 random sets match the brute-force optimum', () => {
    const rand = mulberry32(12345);
    let multiGroupCases = 0;
    for (let iter = 0; iter < 200; iter++) {
      const n = 2 + Math.floor(rand() * 6); // 2..7
      const vals: number[] = [];
      for (let i = 0; i < n - 1; i++) vals.push(Math.floor(rand() * 31) - 15); // -15..15
      vals.push(0 - vals.reduce((s, v) => s + v, 0));
      const b: Balances = {};
      vals.forEach((v, i) => (b[`m${i}`] = v));

      const pays = minimizePayments(b);
      expectSettled(b, pays);
      expect(pays.length).toBeLessThanOrEqual(n - 1);

      const nonzero = vals.filter((v) => v !== 0);
      const groups = bruteMaxGroups(nonzero);
      if (groups >= 2) multiGroupCases++;
      expect(pays.length).toBe(nonzero.length - groups);
    }
    expect(multiGroupCases).toBeGreaterThan(20); // the optimum check is not vacuous
  });

  it('performance: 20 members with distinct balances run the full DP fast', () => {
    const rand = mulberry32(99);
    const used = new Set<number>();
    const vals: number[] = [];
    while (vals.length < 19) {
      const mag = 1 + Math.floor(rand() * 5_000_000);
      const v = rand() < 0.5 ? -mag : mag;
      if (used.has(mag)) continue;
      used.add(mag);
      vals.push(v);
    }
    const last = -vals.reduce((s, v) => s + v, 0);
    expect(last).not.toBe(0);
    expect(used.has(Math.abs(last))).toBe(false); // no exact pairs, so all 20 go through the DP
    vals.push(last);
    const b: Balances = {};
    vals.forEach((v, i) => (b[`m${String(i).padStart(2, '0')}`] = v));

    const t0 = performance.now();
    const pays = minimizePayments(b);
    const ms = performance.now() - t0;
    expectSettled(b, pays);
    expect(pays.length).toBeLessThanOrEqual(19);
    expect(ms).toBeLessThan(2000);
  });

  it('more than 20 non-zero members falls back to greedy and still settles', () => {
    const rand = mulberry32(7);
    const vals: number[] = [];
    for (let i = 0; i < 29; i++) vals.push(Math.floor(rand() * 200001) - 100000);
    vals.push(0 - vals.reduce((s, v) => s + v, 0));
    const b: Balances = {};
    vals.forEach((v, i) => (b[`m${String(i).padStart(2, '0')}`] = v));
    const pays = minimizePayments(b);
    expectSettled(b, pays);
    expect(pays.length).toBeLessThanOrEqual(vals.filter((v) => v !== 0).length - 1);
  });
});
