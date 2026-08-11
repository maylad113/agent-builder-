# AI Agent Factory — Architecture & Conventions

Persistent memory for this repository. Read first when working on this project.

## Current state (2026-08-10, hardening pass — tool permissions + integration sanitization + E2E)
- **126 tests across 17 files, all passing.** `npx tsc --noEmit` clean, `npm run build` clean, production smoke verified.
- **25/25 Phase-25 E2E tests pass in production mode** (fresh DB): login → create business+services+hours → generate agent (NEEDS_INPUT, no invented facts) → create agent+version → add knowledge → readiness check → publish → activate → widget chat (200, conversation stored) → wrong-origin blocked (403) → conversation persisted → create Business B → tenant isolation verified → duplicate business → clone has correct tenant.
- Migration count: **6**. Production server verified end-to-end: migrations auto-apply, health/SPA/widget.js 200, login requires SESSION_SECRET, widget chat from allowed origin 200 + conversation stored + graceful WAITING_FOR_HUMAN fallback, from disallowed origin 403, Meta/Twilio webhooks 403 NOT_CONFIGURED without crashing. Data persists across server restart (verified with SQLite WAL).
- This hardening pass added:
  - **Backend tool-permission enforcement (defense-in-depth)**: `executeAgentTool` now independently verifies the tool is in the agent's `allowedToolNames` before execution — even if the LLM hallucinates a tool name not declared to it, the backend rejects it. 3 regression tests added.
  - **Integration sanitization**: all integration API responses now use `sanitizeIntegrationForClient` (previously defined but unused on GET/PUT endpoints).
  - **Service duration shorthand**: business creation accepts both `durationMinutes` (canonical) and `duration` (common shorthand) for service duration.
  - **Production fixes (prior commit)**: DB_PATH directory handling (appends default filename if directory), COOKIE_SECURE env override + trust proxy for reverse-proxy HTTPS, widget 503 for config errors, ACTIVE status gate in runtime (PAUSED/ARCHIVED agents don't serve customers).
  - **Appointment engine v2** (`src/server/appointmentEngine.ts`): timezone-aware day-of-week, holiday/closed-day/hours/duration-overflow/minimum-notice/maximum-advance validation, staff-coverage slot generation with bidirectional service-buffer overlap, parseBookingNotice policy parsing. `tools.ts` book/reschedule share ONE transactional overlap+buffer guard (race-condition safe, tested in concurrency.test.ts + tools.test.ts).
  - **Webhooks** (`src/server/webhooks.ts`, mounted at `/api/webhooks` before global body parsers): Meta Instagram (GET verify-token + POST X-Hub-Signature-256 HMAC) and Twilio (POST X-Twilio-Signature HMAC-SHA1 + missed-call AI receptionist + STOP opt-out). Server-side business resolution from page-id/phone-number (never trusts inbound tenant id). Idempotent via processed-id dedup (re-delivery safe). 11 tests over real loopback HTTP.
  - **Capped list pagination**: high-volume list endpoints return capped array (default 50, max 100) with `X-Total-Count`/`X-Next-Cursor` headers.
  - **Mass-assignment fix**: `PUT /appointments/:id` uses explicit `{status, notes}` allow-list.
  - **Widget Origin-header bypass fix**: production mode rejects `/runtime/chat` with NO Origin header.
- Security audit results: no hardcoded secrets, no SQL injection (all parameterized), no XSS (widget uses textContent), no stack traces in responses, credentials never returned to frontend (stored in separate in-memory store), webhook signatures verified with timingSafeEqual + length checks, rate limiting on login (20/min) + widget (60/min), secure headers (nosniff, SAMEORIGIN, HSTS, referrer-policy, permissions-policy), body size limit 1MB.
- Phases BLOCKED on external credentials: 13 (Google Calendar), 14 (Meta/Instagram), 15 (Twilio), 16 (Voice). The provider interfaces + real official-API validation code + webhook signature verification now EXIST and are tested; a missing optional credential leaves the integration NOT_CONFIGURED and does NOT break startup (verified by tests/noOptionalEnv.test.ts + webhooks.test.ts). To fully connect, supply the matching env vars / OAuth tokens via the credentials endpoint.
- **Push to GitHub BLOCKED**: the configured `GITHUB_TOKEN` lacks `Contents: write` scope for `maylad113/agent-builder-`. Commits are local only until a PAT with write access is provided.

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
- `src/server/agentRuntime.ts` — `processAgentMessage` (the runtime loop) +
  `generateSuggestedAgentConfig` (Phase 7, fact-safe, NEEDS_INPUT).
- `src/server/tools.ts` — `executeAgentTool` + `agentToolDeclarations`.
  Booking/orders are transactional with overlap/oversell prevention.
- `src/server/readiness.ts` — `computeAgentReadiness` / `assertActivatable`
  (Phase 20, 12-check composite gate; ACTIVE blocked server-side).
- `src/server/security.ts` — `requestId`, `rateLimit`, `secureHeaders` (Phase 22).
- `src/server/agentVersions.ts` — DRAFT/TESTING/PUBLISHED/ARCHIVED lifecycle.
- `src/server/embeddings.ts` — RAG embeddings (Gemini) + keyword fallback.
- `src/server/integrations.ts` — `IntegrationProvider` abstraction (Google/Meta/Twilio/Voice) + credential store (server-side only) + `runValidation` (only path to CONNECTED).
- `src/server/appointmentEngine.ts` — centralized scheduling: hours/holiday/notice/buffer/staff validation + slot generation (shared by REST API + agent tool).
- `src/server/webhooks.ts` — Meta/Instagram + Twilio webhook router (signature verification, idempotent, missed-call AI receptionist). Mounted at `/api/webhooks` before global body parsers.
- `src/server/widgetSecurity.ts` — per-business widget origin allow-list + CORS header builder.
- `public/widget.js` — embeddable chat widget; derives `apiOrigin` from script src for cross-origin embedding.

## Required vs optional env vars (see .env.example)
- REQUIRED: `SESSION_SECRET` (production refuses to start without it), `DB_PATH`.
- OPTIONAL: `GEMINI_API_KEY`, `GOOGLE_*`, `META_*`, `TWILIO_*`, `VOICE_AI_*`. Absence => NOT_CONFIGURED / graceful fallback; app still starts.

## Conventions
- All tests use an ephemeral temp SQLite DB (`fs.mkdtempSync`) + `delete GEMINI_API_KEY`; never rely on the real environment.
- When adding server routes, wire `requireAuth` + `requireTenantScope` and never return credentials/stack traces to the client.
- Commits are GPG-sign-disabled (`-c commit.gpgsign=false`).

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
