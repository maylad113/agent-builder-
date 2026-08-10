# AI Agent Factory — Architecture & Conventions

Persistent memory for this repository. Read first when working on this project.

## Stack
- TypeScript + Vite (frontend React 19) + Express (backend) in one process.
- better-sqlite3 (synchronous) for persistence; migrations in `migrations/`.
- `@google/genai` (Gemini) for the LLM. `GEMINI_API_KEY` optional — runtime
  falls back to a graceful "trouble connecting" reply + `WAITING_FOR_HUMAN`.
- Build: `vite build && esbuild server.ts -> dist/server.cjs`. Prod: `node dist/server.cjs`.

## Key files
- `src/server/db.ts` — `AppDatabase` + `Collection<T>` wrappers. Exposes
  `db.sqlite` (raw BetterSqlite3.Database) so tools can run transactions.
- `src/server/auth.ts` — session middleware, `requireAuth`, `requireRole`,
  `requireTenantScope` (the multi-tenant guard — derives businessId server-side
  from the authenticated user's membership, NEVER trusts the client).
- `src/server/agentRuntime.ts` — `processAgentMessage` (the runtime loop).
- `src/server/tools.ts` — `executeAgentTool` + `agentToolDeclarations`.
  Booking/orders are transactional with overlap/oversell prevention.
- `src/server/routes.ts` — REST + runtime endpoints.
- `server.ts` — entrypoint (dev + prod). Has global JSON error handler.

## Multi-tenancy (critical)
- Every business-owned row has `businessId`. `requireTenantScope` scopes reads
  to the user's business and rejects cross-tenant writes (403/404).
- The public widget endpoint `/api/runtime/chat` takes `tenantId` in the body
  (customers are unauthenticated) but the runtime scopes ALL db lookups to it
  and IGNORES any client-supplied `conversationId` that doesn't belong to that
  tenant (IDOR fix). Authenticated simulator uses `/api/runtime/simulate`.

## Runtime security invariants (enforced)
- Public `/api/runtime/chat` NEVER returns `debug`/`systemPrompt`/
  `retrievedKnowledge`/`toolCalls` — only `{reply, conversationId, status}`.
  Authenticated `/api/runtime/simulate` returns the full debug block.
- AI is paused when a conversation is in `HUMAN_HANDLING`/`RESOLVED`.
- Errors sent to customers are generic; full errors logged server-side only.
- Tool calls are validated server-side: tenant, args, business rules. The AI
  can only call tools in the agent's `structuredConfig.toolsEnabled` set
  (the runtime filters declarations before handing them to the model).

## Transactions
better-sqlite3 is synchronous and serializes writes. Use
`db.sqlite.transaction(() => {...})()` for check-then-insert atomicity
(appointment overlap, inventory decrement). TS narrowing note: `.transaction`
widens literal `ok` types, so use the `isFail()` type guard in tools.ts
instead of `if (!r.ok)`.

## Commands
- `npm run dev` — dev server (tsx, with Vite middleware)
- `npm run build` — production bundle
- `npm start` — run production (`NODE_ENV=production`)
- `npm test` — vitest
- `npm run lint` — `tsc --noEmit`
- `npm run migrate` — apply SQL migrations

## Env vars
- `PORT` (default 12000 dev / 12000 prod)
- `DB_PATH` (default `./data/app.db`)
- `SESSION_SECRET` — REQUIRED in production for signing session cookies.
  In dev a random per-process secret is generated. If missing in prod, the
  server starts but login returns a clean JSON 500 (not a crash).
- `GEMINI_API_KEY` — optional; runtime degrades gracefully.
- Optional integrations (Google/Meta/Twilio/Voice) — not yet wired; must NOT
  block startup when absent.
