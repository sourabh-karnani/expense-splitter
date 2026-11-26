# Project rules for Claude Code

Stack: Node 22, Express 5 + TypeScript (run with tsx), Mongoose on local MongoDB, React + Vite + TanStack Query.

## How to work
- Make small, focused changes: one route, model or component at a time.
- Copy the existing patterns for new resources: `api/src/routes/notes.ts`, `api/src/models/Note.ts`, `web/src/pages/NotesPage.tsx`.
- After each change run `npm run typecheck` and `npm test` from the repo root, and add or update a test in `api/tests/`.
- Ask before adding a new dependency, and say why it is needed.

## API rules
- Validate every request body and query with Zod. Use `z.strictObject` for bodies so unknown fields are rejected.
- Take the user id only from `currentUserId(req)` (set by `requireAuth`), never from the body, query or params.
- Scope every read, update and delete of user data by owner: `{ _id: id, ownerId: currentUserId(req) }`. Not found or not yours → 404.
- Return data only through an explicit DTO function (like `toNoteDTO`). Never return raw Mongoose documents.
- Lists use cursor pagination on `_id`: default limit 20, max 50. Add an index that matches every new query.
- Throw `HttpError(status, message)` for expected errors. `errorHandler` formats all responses as `{ error: { message } }`.
- `sanitizeFilter` is on: query operators written in code must be wrapped in `mongoose.trusted(...)`.
- No secrets in code. Read configuration from `api/src/env.ts`.

## Frontend rules
- Call the API only through `api()` in `web/src/api.ts`. Never store tokens in localStorage; the session is an httpOnly cookie.
- Every query and mutation shows loading and error states.
- Render user content as text. Never use `dangerouslySetInnerHTML`.
