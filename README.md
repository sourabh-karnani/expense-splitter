# Expense splitter

Split trip and group expenses, see who owes whom, and settle up in the fewest payments.

Express 5 + TypeScript API, MongoDB (Mongoose), React + Vite frontend.

## Features

- **Groups:** create a group and invite people with a short link (`/j/<code>`, valid 24 hours, owner can regenerate). Members can also add friends who have no account (name only); a friend can claim that spot later when joining by link. Up to 20 members.
- **Expenses:** amount, title, description, date. Split **equally** among the people selected (so anyone not involved is left out), by **exact amounts**, or by **shares** (e.g. nights stayed). One expense can have **several payers**.
- **Edits:** any member can fix an expense. Edits are versioned (a stale edit gets 409 instead of overwriting someone else's), and every create, edit and delete is kept in the expense's history.
- **Balances and settle up:** suggested payments use the fewest transactions possible (see below).
- **Payments, including partial and cash:** a payment recorded by the payer waits for the receiver to confirm it; one recorded by the receiver counts at once. A payment can't exceed what the payer owes or what the receiver is owed, counting payments still waiting for confirmation.
- **Settle across groups:** two people who share several groups can settle everything with one payment; it is stored with one part per group, so every group's balances stay correct.

## Settle-up algorithm (`api/src/lib/settle.ts`)

All money is integer paise. Each member's balance = paid − owed + payments sent − payments received; balances sum to 0.

1. People with exactly opposite balances pay each other in full (one payment each).
2. For the rest, the fewest payments equals (people with a balance − the largest number of groups whose balances sum to zero). A bitmask search over subsets finds those groups exactly; it takes about 25 ms for 20 people.
3. Inside each group, the largest debtor pays the largest creditor until everyone is at zero.

Rounding is deterministic: leftover paise go to members in join order, so splits always add up to the total.

## Run

```bash
npm run dev        # API on http://localhost:4000, web app on http://localhost:5173
npm test           # API tests (use the separate expense_splitter_test database)
npm run typecheck  # API and web
```

Needs MongoDB on `127.0.0.1:27017`. API config is in `api/.env` (template: `api/.env.example`).
`requests.http` has ready-made API calls for the VS Code REST Client extension.

## Layout

| Path | What it does |
|---|---|
| `api/src/server.ts` | Connects to MongoDB, starts the server |
| `api/src/app.ts` | Security middleware, routes, error handler |
| `api/src/env.ts` | Validates config at startup (fails fast) |
| `api/src/db.ts` | MongoDB connection, query sanitising |
| `api/src/middleware/auth.ts` | Session cookie, `requireAuth`, `currentUserId` |
| `api/src/middleware/errors.ts` | 404 and error responses |
| `api/src/routes/auth.ts` | Register, login, logout, me |
| `api/src/routes/groups.ts` | Groups, members, invite links, join, balances |
| `api/src/routes/expenses.ts` | Expenses with versioned edits and history |
| `api/src/routes/settlements.ts` | Payments, confirm/reject, settle across groups |
| `api/src/lib/settle.ts` | Splitting, balances, fewest-payments algorithm (pure functions) |
| `api/src/lib/groupLedger.ts` | Membership checks, group balances, invite codes |
| `api/src/routes/notes.ts` | Example CRUD resource from the starter |
| `api/tests/` | Algorithm, API and security tests |
| `web/src/api.ts` | Fetch wrapper and shared types |
| `web/src/pages/` | Groups, group, expense form, join, settle-with, login pages |
| `PLAN.md` | Design decisions, data model and API contract |

## Security decisions (OWASP API Top 10, 2023)

- **Object-level authorization (API1):** group data is only visible to group members; everything else is filtered by `ownerId` from the session. Other people's records return 404. Payers, split members and payment parties must belong to the same group.
- **Authentication (API2):** argon2id password hashes, a 1-hour JWT pinned to HS256 in an httpOnly cookie, the same error for wrong email or wrong password, a constant-time path for unknown emails, and a stricter rate limit on login and register.
- **Property-level authorization (API3):** `z.strictObject` rejects unknown input fields (no mass assignment), and DTO functions whitelist output fields (`passwordHash` is `select: false` and never returned).
- **Resource consumption (API4):** a 100 kb body limit, page size capped at 50, and a per-IP rate limit.
- **Misconfiguration (API8):** helmet security headers, a CORS allowlist, no stack traces in responses, config validated at startup.
- **Injection:** Mongoose `sanitizeFilter` neutralises `$` operators in user input, and Zod types reject objects where strings are expected.
- **Frontend:** no tokens in JavaScript (the httpOnly cookie defends against token theft by XSS); `SameSite=Lax` plus JSON-only bodies defend against CSRF; React escapes all rendered text.

## Trade-offs to mention

- **JWT vs server sessions:** a JWT needs no session store, but can't be revoked before it expires. Next step: a short access token plus a rotating refresh token, or a token version on the user.
- **409 on duplicate email** tells an attacker that an account exists. The alternative is always returning "check your email".
- **Cursor vs offset pagination:** a cursor stays fast and stable as data grows; offset allows jumping to page N.
- **Rate limits are in memory:** fine for one process; use a Redis store when running several instances.
- **MongoDB without transactions:** anything that must change together is one document (an expense with its splits and history; a payment with its per-group parts), and conditional updates prevent races. Two confirmations at the very same instant could still both pass the overpay check; a replica set with transactions, or Postgres, would close that.
