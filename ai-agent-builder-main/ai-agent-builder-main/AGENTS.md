# AI Agent Factory — Architecture & Conventions

Persistent memory for this repository. Read first when working on this project.

## Current state (2026-08-10, hardening pass)
- **75 tests across 14 files, all passing.** `npx tsc --noEmit` clean, `npm run build` clean.
- Migration count is now **6** (added `006_integration_states_widget_origins.sql`).
- Production server verified: `node dist/server.cjs` applies 6 migrations, health/SPA/widget.js all 200, widget chat from disallowed origin returns 403, integration validate with bogus creds returns ERROR (live Google API probe).
- Hardening pass completed:
  - **P1.1 Integration lifecycle**: `src/server/integrations.ts` defines `IntegrationProvider` (Google/Meta/Twilio/Voice) with real API-probe `validate()`. `IntegrationConfig.state` replaces the old `connected` boolean (NOT_CONFIGURED/CONFIGURING/CONNECTED/ERROR/DISCONNECTED). The PUT route no longer accepts `state`/`connected` from the client; the ONLY path to CONNECTED is POST `/:id/credentials` + POST `/:id/validate`. Credentials are server-side only (never in the DB row or API response).
  - **P1.2 Widget origin enforcement**: `src/server/widgetSecurity.ts`. `/runtime/chat` OPTIONS+POST enforce `business.allowedWidgetOrigins`. Widget sends `?business=` query + `x-business-id` header so the preflight can resolve the tenant.
  - **P1.3 Published-version enforcement**: `agentRuntime.processAgentMessage` adds a `simulator` flag; production path uses `getPublishedVersion()` ONLY and escalates to a human (never serves a draft) when no version is published. The old `ACTIVE||READY||TESTING` fallback-to-any-agent is removed.
  - **P1.4 Order transaction rollback**: `tools.ts` order creation now THROWS inside `db.sqlite.transaction()` (only a throw rolls back in better-sqlite3); caught outside and returned as a failure. Failed multi-item orders leave inventory unchanged (no partial deduction).
  - **P2 Session cookie**: `secure` flag is now `process.env.NODE_ENV === 'production'`.
  - **Mass-assignment**: PUT `/businesses/:id` uses an allowlist (never `Object.assign`); supports new `holidays` + `allowedWidgetOrigins`.
- Phases BLOCKED on external credentials: 13 (Google Calendar), 14 (Meta/Instagram), 15 (Twilio), 16 (Voice). The provider interfaces + real official-API validation code now EXIST (Phase 11/P1.1); a missing optional credential leaves the integration NOT_CONFIGURED and does NOT break startup (verified by tests/noOptionalEnv.test.ts). To fully connect, supply the matching env vars / OAuth tokens via the credentials endpoint.

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
