# GHL starter

Express 5 + TypeScript API, MongoDB (Mongoose), React + Vite frontend.

## Run

```bash
npm run dev        # API on http://localhost:4000, web app on http://localhost:5173
npm test           # API tests (use the separate ghl_test database)
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
| `api/src/routes/notes.ts` | Example CRUD resource: the pattern to copy |
| `api/tests/api.test.ts` | Auth, CRUD, ownership, validation, pagination tests |
| `web/src/api.ts` | Fetch wrapper and shared types |
| `web/src/pages/` | Login and Notes pages |

## Security decisions (OWASP API Top 10, 2023)

- **Object-level authorization (API1):** every query on user data is filtered by `ownerId` from the session. Other users' records return 404.
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
