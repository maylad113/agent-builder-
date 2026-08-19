# AI Agent Factory — Architecture & Conventions

Persistent memory for this repository. Read first when working on this project.

## Current state (2026-08-19, P1 — PostgreSQL production path repaired end-to-end)
- **400 tests across 31 files, all passing** (378 legacy + 11 splitter unit + 7 real-PG integration + 4 rate-limit selection). `npx tsc --noEmit` clean, `npm run build` clean. Production smoke verified on BOTH dialects (SQLite + real PostgreSQL 16 in Docker): boot → migrations → login → tenant API → widget chat with graceful no-provider handoff.
- **POSTGRESQL PRODUCTION PATH WAS BROKEN; NOW FIXED (audit P1, 2026-08-19).** Three independent defects made the PG backend non-functional/dangerous while SQLite was green:
  1. **Fresh PG init crashed** — `splitStatements()` split migration scripts on `;` inside `--` comments → `syntax error at or near "when"`. Fixed: splitter now respects `--` line + `/* */` block comments and drops comment-only fragments.
  2. **PG "transactions" were fake** — `PostgresClient.transaction()` ran BEGIN/COMMIT on a checked-out client but the callback's queries (incl. every `Collection` method) went through `pool.query` on OTHER connections: no atomicity, no rollback, `FOR UPDATE` locks released instantly → double-bookings + partial inventory deductions were possible. Fixed: `AsyncLocalStorage` per-context binding (`txStore`); `query`/`exec`/`execMany`/`getColumns` use the tx client when present; nested `transaction()` joins the enclosing tx. Negative control confirmed: pre-fix run leaked a rolled-back row and double-booked; post-fix exactly one winner + clean rollback.
  3. **Empty-set race** — appointment `FOR UPDATE` locks nothing when no rows exist for the date; two concurrent FIRST bookings could both win even with real transactions. Fixed: booking + reschedule transactions lock the always-present parent business row first (`SELECT id FROM businesses WHERE id=? FOR UPDATE`), serializing per-tenant booking on PG (SQLite strips FOR UPDATE; mutex serializes).
- **PG schema drift fixed (migration `pg/016_dialect_parity.sql`)**: PG was missing `agents.paused_from`, `staff_members.working_hours`, `staff_members.time_off` (SQLite 007/009) → `Collection.push` SILENTLY DROPPED those fields on PG; and `usage_records.input_tokens/output_tokens` were NOT NULL on PG vs nullable on SQLite → fresh-DB seed crashed on PG. Rule learned: **this Collection layer always INSERTs explicit NULL for absent fields, so any column it writes must be nullable** (DEFAULTs never fire). A sqlite↔pg schema diff (init both, compare information_schema vs PRAGMA) is the reliable audit method; remaining diffs are intentional (webhook idempotency table names per dialect, sqlite-only `rate_limit_buckets`).
- **PG production boot crash fixed**: `selectStore()` defaulted to `SqliteRateLimitStore` in production, which throws without a sqlite handle → PG server could not start. New pure `resolveRateLimitStoreKind(env, nodeEnv, sqliteAvailable)`; PG production falls back to in-memory limiting with a warning (per-process limitation; set `RATE_LIMIT_STORE=memory` to silence). Explicit `RATE_LIMIT_STORE=sqlite` on PG still fails loudly.
- **PG integration tests**: `tests/pgTransactions.test.ts` runs against a REAL PostgreSQL when `PG_TEST_URL` is set (maintenance URL; creates/drops a throwaway DB per run) and SKIPS explicitly otherwise. Covers fresh-init migrations, rollback-on-throw, commit, concurrent same-slot booking (exactly one winner), multi-item order rollback (no partial inventory), concurrent last-unit orders (no oversell), cross-tenant concurrent transactions. `tests/dbClient.test.ts` unit-tests `splitStatements`/`stripForUpdate` incl. the real pg migration files.
- Historical note: the pre-checkpoint local commits referenced in older notes (e.g. ca933f86 "PG transaction callback binding") were never pushed and are LOST; main @ 6f4a7f0 (squashed checkpoint) + this session's work is the whole state. GitHub token now has Contents:write (push unblocked, but NOT pushed — local commit only).

## Previous state (2026-08-17, Phase 7 — persistent encrypted integration credentials)
- **378 tests across 29 files, all passing.** `npx tsc --noEmit` clean, `npm run build` clean (dist/server.cjs 281.0kb), production smoke verified end-to-end (save encrypted → DB row is ciphertext → restart → validate decrypts + hits real provider API → 401 rejected bogus token, proving persistence).
- **PERSISTENT ENCRYPTED INTEGRATION CREDENTIALS (P1 security, 2026-08-17)**: integration credentials were previously held only in an in-process `Map` and lost on every server restart. They are now encrypted (AES-256-GCM, fresh 12-byte IV per op, auth tag verified) and persisted to a new `integration_credentials` table, surviving restarts. `src/server/credentialCrypto.ts` provides `encryptCredentials`/`decryptCredentials` + key resolution (`INTEGRATION_ENCRYPTION_KEY` preferred, else HKDF-derived from `SESSION_SECRET`; if neither, storage REFUSES — never plaintext). `src/server/integrations.ts` `storeCredentials`/`getCredentials`/`clearCredentials` are now async + tenant-scoped `(integrationId, businessId, provider, creds)` — every query filters `WHERE integration_id = ? AND business_id = ?` so cross-tenant access returns nothing; UNIQUE(integration_id) prevents duplicate records. Decryption happens only inside these trusted server functions; `sanitizeIntegrationForClient` strips any secret-looking configData key. Callers updated: routes.ts (credentials POST /validate /disconnect) + webhooks.ts (3 read sites). Key rotation: documented as an offline job (re-encrypt rows by key_id) — multi-key live decryption intentionally NOT held in memory. Config: `INTEGRATION_ENCRYPTION_KEY` (else `SESSION_SECRET`); default none → storage 503s. 22 new tests in `tests/credentialStore.test.ts`.
- **LLM PROVIDER TIMEOUTS (P1 reliability, 2026-08-17)**: every outbound LLM/embedding network request is now bounded so a hung/slow provider daemon can never hold an Express request open indefinitely (was: `fetch`/SDK calls had no timeout → connection/memory exhaustion under load). `src/server/llmProvider.ts` adds `createLlmTimeout(ms)` (AbortController + unref'd timer + `dispose()`), `resolveTimeoutMs`/`providerTimeoutMs` (env-driven, invalid/negative/zero ALWAYS fall back to the 60s default — protection can never be silently disabled), and `isAbortError`. The Ollama adapter passes `signal` to `fetch`; the Gemini adapter passes `abortSignal` + `httpOptions.timeout` in the SDK config. On abort, each adapter returns its EXISTING normalized error response (`{text:'', functionCalls:[], error:'... timed out after Xms'}`) — the runtime then degrades to the graceful human-handoff reply via the SAME path as an unreachable daemon (`response.error` → throw → catch → `WAITING_FOR_HUMAN` + "trouble connecting"). A timeout NEVER fabricates an answer and NEVER throws an uncaught AbortError into the runtime. 18 new tests in `tests/llmProvider.test.ts`. Config: `LLM_REQUEST_TIMEOUT_MS` (global), `OLLAMA_REQUEST_TIMEOUT_MS`/`GEMINI_REQUEST_TIMEOUT_MS` (per-provider overrides); default 60000ms.
- **IDOR FIX (audit P0, 2026-08-16)**: agent version mutation routes (`publish`/`editDraft`/`rollback`/`archive`/`moveToTesting`/`createDraftFrom`) previously authorized the parent `:id` (agent) via `requireResourceAccess` but did NOT verify `:versionId` belonged to that agent. A tenant authorized for agent A could supply A's id in the path + B's version id in `:versionId` and the mutation acted on B's version across the tenant boundary. Fixed: every mutation function in `agentVersions.ts` now accepts an optional `expectedAgentId` and verifies `version.agentId === expectedAgentId` via `requireVersionForAgent` (throws "Version not found" — no existence leak). The evaluation route uses `versionBelongsToAgent` to reject a foreign versionId with 404. `runSelfCorrection` already verified ownership (line ~405). Regression test `versions.test.ts > "rejects a foreign version id"` covers all 7 mutation vectors; negative control confirmed it catches the bug (without the fix, the publish returns 200 and the foreign version becomes PUBLISHED).
- **Usage Monitoring + Observability** (`src/server/telemetry.ts`): records REAL events from the agent runtime, tool execution, evaluation, correction, and publish paths into a tenant-scoped `telemetry_events` table. The LLM NEVER writes telemetry — recording is server-side only at well-defined seams.
  - **Event types**: `CUSTOMER_MESSAGE`, `AGENT_RESPONSE`, `TOOL_EXECUTION`, `HUMAN_HANDOFF`, `EVALUATION_RUN`, `CORRECTION_ATTEMPT`, `VERSION_PUBLISHED`.
  - **Privacy**: records prefer metadata + safe truncated summaries over raw conversation content (the `messages` table remains the content store). Tool args are NEVER stored (only tool name + success + a safe error summary). No secrets/credentials ever appear in telemetry (verified by test + production smoke scan).
  - **Published vs draft/test separation**: every event carries `isPublished`. Production widget (`/api/runtime/chat`) → `isPublished=true` (real PUBLISHED-agent activity). Simulator/eval/correction → `isPublished=false` (DRAFT/TESTING activity). The monitoring UI and `?isPublished=` query param separate these. `effectiveVersionId` is hoisted in the runtime so telemetry is associated with the exact published/draft version.
  - **Recording is best-effort and never throws** into the request path (a telemetry failure must not break a customer conversation or a publish). Only the main executed runtime path records AGENT_RESPONSE/HANDOFF — the early no-agent / no-published / non-ACTIVE fallbacks return before recording, so metrics reflect real agent activity.
  - **Tenant isolation**: every record is `business_id`-scoped; queries are scoped by `businessId` and never return cross-tenant rows (verified by test + production smoke). No write endpoints exist (telemetry is server-side recorded only).
  - **Query/aggregate API** (`listTelemetryEvents`, `computeMetrics`, `countTelemetry`): metrics include conversations, messages, agentResponses, successful/failed tool calls, human handoffs, average latency, provider/model usage, eval passes/failures, correction count, and `hasPublishedActivity`/`hasDraftActivity` flags (so the UI shows an honest empty state — never fabricated numbers).
  - **Monitoring routes** (`src/server/routes.ts`): `GET /api/agents/:id/telemetry` + `GET /api/agents/:id/metrics` — both `requireAuth` + `requireResourceAccess` (agent-scoped, business derived server-side). Unauthenticated → 401 (verified).
  - **Monitoring UI** (`src/components/MonitoringView.tsx`): new "Monitoring" tab in Business Owner Portal. Shows metrics grid, provider/model usage, correction count, and a recent-activity feed. Activity filter (Published / Draft-Test / All) drives the `isPublished` query param. Honest empty state when no activity exists. All strings verified in the production bundle.
  - **Migration 013** (`migrations/013_telemetry.sql` + PG schema): `telemetry_events` table + indexes. Self-healing via `initTelemetryTable()` so fresh DBs and PG get it idempotently. Migration count now **9**.
  - Production smoke verified (fresh DB): migrations auto-apply (013 logged), unauth monitoring routes 401, real widget chat to an ACTIVE published agent records CUSTOMER_MESSAGE + AGENT_RESPONSE (latency, provider/model, tokens) + HUMAN_HANDOFF with `isPublished=true`; metrics route returns real aggregates; draft/test simulator activity recorded as `isPublished=false`; cross-tenant query returns no foreign rows; no secrets/PII/args in telemetry records; public chat response stays minimal (`{reply, conversationId, status, agentAvailable}` — no debug leak).
  - Tests: 17 in `tests/telemetry.test.ts` — recorder unit tests (metadata + safe summaries, never args/secrets), computeMetrics aggregation + zero-state (never fabricates), isPublished filter separation, real-runtime integration (widget chat records telemetry; public response never leaks debug), monitoring-route auth + tenant isolation, telemetry-record secret/arg scan.
- **Per-Conversation Drill-Down** (MonitoringView "Conversations" section + `GET /api/agents/:id/conversations` + `GET /api/agents/:id/conversations/:conversationId`): a business owner can open a real customer conversation from Monitoring and see exactly what happened — the conversation metadata (status/channel/timestamps/handoff reason) + a chronological timeline of every telemetry event (CUSTOMER_MESSAGE / AGENT_RESPONSE / TOOL_EXECUTION / HUMAN_HANDOFF / EVALUATION_RUN / CORRECTION_ATTEMPT / VERSION_PUBLISHED) with actor classification, agent name + version association, provider/model, latency, tokens, and published/test separation. Built ON the existing telemetry system — no new session id or duplicate data; the durable conversation id (`Conversation.id`, created by `ensureConversation`) already groups events.
  - **Routes** (`src/server/routes.ts`): both `requireAuth` + `requireResourceAccess(req => db.agents.find(...))` — the agent is the tenant anchor; every conversation lookup is scoped to the agent's `businessId`. `getConversationTimeline` requires BOTH `conversationId` AND `businessId` match, so a cross-tenant or non-existent id returns null → 404 (no existence leak).
  - **Privacy**: the timeline entry mirrors the privacy-safe telemetry record — tool name + success/failure ONLY, never args/secrets. Verified by test (args field absent + secret/PII regex scan) + production smoke.
  - **Functions** (`src/server/telemetry.ts`): `listConversationsFromTelemetry` (groups events by conversationId, enriches with the conversation row + agent name, computes per-conversation counts, newest-activity-first, capped limit) + `getConversationTimeline` (single conversation + ascending chronological timeline, agent-name + version-label enrichment, honest empty state when no events).
  - **Bug fixed**: `record()` was building `{ id, timestamp, ...event }` which let an undefined `timestamp` in the spread clobber the computed timestamp (surfaced when recorders gained an optional `timestamp` param). Now spread-first so an explicit caller timestamp wins but an undefined one does not. All recorders (`recordCustomerMessage`, `recordAgentResponse`, `recordToolExecution`, `recordHumanHandoff`) accept an optional `timestamp` for test/backdated recording.
  - **UI** (`src/components/MonitoringView.tsx`): conversation list (clickable rows with customer/status/counts/published badge) + a `ConversationTimelineView` modal (conversation metadata, chronological timeline with actor-colored entries, tool name+outcome only, agent/version/provider/latency/tokens strips, honest empty state, Escape to close). The UI never authorizes — it only renders what the tenant-scoped API returns.
  - **Migration 014** (`migrations/014_telemetry_conversation_index.sql` + PG schema): `idx_telemetry_conversation(business_id, conversation_id, timestamp)` for efficient drill-down lookups. Also added to `initTelemetryTable()` so fresh DBs/PG get it idempotently. Migration count now **10**.
  - Production smoke verified (fresh DB): migration 014 auto-applies, unauth routes 401, real widget chat → conversation list shows the real conversation with counts → timeline shows CUSTOMER→AGENT→HANDOFF chronologically with agent name + v1 PUBLISHED version + isPublished=true, no args leaked, nonexistent conv 404, isPublished filter separates published vs test.
  - Tests: 24 in `tests/conversationDrillDown.test.ts` — direct function tests (chronological grouping + actor classification, agent/version enrichment, tool name+success never args, provider/latency, isPublished flags, null for non-existent + cross-tenant), listConversations tests (grouping + counts + tenant isolation + isPublished filter + newest-first + honest empty), API route tests (auth + tenant isolation + no-leak 404 + published/test separation + no args/secrets), migration tests (index exists + initTelemetryTable idempotent).
- **Factory Control Center UI** (`src/components/FactoryControlCenter.tsx` + `src/components/controlCenterLogic.ts`): a "Factory Control Center" tab in the Business Owner Portal that exposes the full agent lifecycle to a real business owner — Select/open agent → view current version/status → run evaluation → display scenario results/score/failures/FailureCategory → start self-correction → display correction proposals/results → clearly show when HUMAN REVIEW is required → re-run evaluation after correction → show why publishing is blocked when evaluation fails → publish (server-gated) → show published version/status.
  - **The UI NEVER implements authorization or publish rules.** Every state change (evaluate, correct, create-draft, publish) is a real API call to the existing routes; the server-side evaluation/publish gates remain authoritative. The Publish button calls the server and displays the server's response (success OR the blocked error) — it never decides locally whether publish is allowed.
  - `controlCenterLogic.ts` holds the pure DISPLAY helpers (`summarizeEvaluation`, `publishGateHint`, `summarizeCorrection`, `requiresHumanReview`, `correctionActionLabel`, `isAutoSafeProposal`, `failureCategoryBadge`) — display-only, mirror the server's blocked-message format for surface hints, never act as a gate. The component is split into a container (`FactoryControlCenter`, fetches + calls API) and a presentational `ControlCenterView` (takes state, renders).
  - PUBLISHED versions are visibly locked: evaluate/correct/publish buttons disabled + a banner explaining the server refuses to edit/correct a PUBLISHED version (create a new draft). Scenarios editor is editable only on non-published versions.
  - Human-review banner (safety / unresolved / max-attempts) is prominent and explicitly states the UI will never auto-approve a safety correction or bypass the publish gate.
  - Production smoke verified: SPA 200, the bundle ships "Factory Control Center" + all lifecycle strings; the API flow (login → versions → create draft → evaluate → correct → publish-blocked) returns the expected server responses; correction on a PUBLISHED version is rejected server-side.
  - Tests: 25 in `tests/controlCenter.test.ts` — pure helper unit tests (summarize/score/failure-categories, publish-gate-hint display mirroring, human-review detection, action labels, safety flags) + `renderToStaticMarkup` smoke tests of `ControlCenterView` verifying it renders the score/PASSED-FAILED badge, failure categories, publish-blocked reason, human-review banner, correction attempts, resolved-vs-unresolved, published-LIVE, and PUBLISHED-version lock. (No DOM testing-library exists in the project; vitest runs in `node` env, so the presentational view is tested via `react-dom/server` renderToStaticMarkup — real component rendering without a new test stack.)
- Migration count: **9** (011 evaluation + 012 correction + 013 telemetry). Production server verified end-to-end: migrations auto-apply, `evaluation_results` + `correction_runs` + `telemetry_events` tables self-create, evaluate/correct/publish/monitoring routes return the expected server responses, publish gate blocks on critical failures (not bypassed), correction on a PUBLISHED version rejected 400, monitoring routes 401 unauthenticated.
- **Agent Self-Correction Loop** (`src/server/correction.ts`): closes GENERATE → EVALUATE → CLASSIFY FAILURE → CORRECT → RE-EVALUATE → PASS / HUMAN REVIEW → PUBLISH. Deterministic `proposeCorrection` mapping (authoritative; LLM only optionally phrases instruction text, sanitized, never grants tools / weakens safety). Free-first: deterministic templates when no provider. MISSING_TOOL → ENABLE_TOOL only when the tool exists in `ALL_TOOL_NAMES` (else human review; never fabricates a tool). MISSING_KNOWLEDGE → ADD_KNOWLEDGE_FROM_SOURCE only from owner-provided `TrustedKnowledgeSource` content (else human review; never fabricates facts). SAFETY_FAILURE → ALWAYS human review. Applies corrections to a NEW DRAFT (never mutates PUBLISHED). Bounded by `MAX_CORRECTION_ATTEMPTS` (default 3). Persisted in `correction_runs` (auditable, tenant-scoped). Does NOT bypass `assertPublishClear`. Routes: `POST .../correct`, `GET /agents/:id/corrections`. 35 tests in `tests/correction.test.ts`.
- **LLM provider abstraction (free-first)**: `src/server/llmProvider.ts` (Gemini + Ollama) + `resolveProviderAndModel()` / `resolveEmbeddingProvider()`. No mandatory paid API: when `GEMINI_API_KEY` is absent the runtime resolves to the local Ollama adapter and degrades gracefully. Agent.llmProvider includes `'ollama'`.
- **RAG pipeline provider-agnostic**: `src/server/embeddings.ts` routes embedding through `EmbeddingProvider`; model-tagged vectors; tenant-scoped keyword fallback. `initEmbeddingsTable()` self-heals the `model` column. Background indexing gated on `embeddingProviderAvailable()`.
- **Agent Evaluation Engine** (`src/server/evaluation.ts`): executes scenarios against the REAL runtime (simulator mode against DRAFT/TESTING, never PUBLISHED), deterministic scoring + structured `FailureCategory` classification, optional LLM judge (skipped when no provider; never overrides a critical deterministic failure; never throws). Persisted in `evaluation_results`. Publish gate `assertPublishClear` blocks on critical failures (missing eval does NOT block — backward compat). Routes: `POST .../evaluate`, `GET .../evaluations`, `GET /agents/:id/evaluations`. 24 tests in `tests/evaluation.test.ts`.
- Prior hardening pass (tool-permission enforcement, integration sanitization, appointment engine v2, webhooks, capped pagination, mass-assignment fix, widget origin bypass fix) preserved and still passing.
- Security audit results: no hardcoded secrets, no SQL injection (all parameterized), no XSS (widget uses textContent), no stack traces in responses, credentials never returned to frontend, webhook signatures verified with timingSafeEqual + length checks, rate limiting on login (20/min) + widget (60/min), secure headers, body size limit 1MB. Evaluation + correction records are tenant-scoped on read. The UI never implements authorization/publish rules — server gates are authoritative.
- Phases BLOCKED on external credentials: 13 (Google Calendar), 14 (Meta/Instagram), 15 (Twilio), 16 (Voice). The provider interfaces + real official-API validation code + webhook signature verification now EXIST and are tested; a missing optional credential leaves the integration NOT_CONFIGURED and does NOT break startup.
- **Push to GitHub BLOCKED**: the configured `GITHUB_TOKEN` lacks `Contents: write` scope for `maylad113/agent-builder-`. Commits are local only until a PAT with write access is provided.

## Stack
- TypeScript + Vite (frontend React 19) + Express (backend) in one process.
- better-sqlite3 (synchronous) for persistence; migrations in `migrations/`.
- `@google/genai` (Gemini) for the optional cloud LLM. **FREE-FIRST**: the
  platform runs without a paid API via the local/open-source Ollama provider.
  `GEMINI_API_KEY` optional — when absent and no provider is declared, the
  runtime resolves the free Ollama adapter; if that daemon is also down, it
  degrades to a graceful "trouble connecting" reply + `WAITING_FOR_HUMAN`.
- Build: `vite build && esbuild server.ts -> dist/server.cjs`. Prod: `node dist/server.cjs`.

## Key files
- `src/server/db.ts` — `AppDatabase` + `Collection<T>` wrappers. Exposes
  `db.sqlite` (raw BetterSqlite3.Database) so tools can run transactions.
- `src/server/auth.ts` — session middleware, `requireAuth`, `requireRole`,
  `requireTenantScope` (the multi-tenant guard — derives businessId server-side
  from the authenticated user's membership, NEVER trusts the client).
- `src/server/agentRuntime.ts` — `processAgentMessage` (the runtime loop) +
  `generateSuggestedAgentConfig` (Phase 7, fact-safe, NEEDS_INPUT). Resolves
  the LLM via `llmProvider.ts` (never imports a vendor SDK directly).
- `src/server/llmProvider.ts` — **FREE-FIRST provider abstraction**.
  `LlmProvider` interface + `GeminiLlmProvider` (optional cloud) and
  `OllamaLlmProvider` (local/open-source, OpenAI-compatible `/api/chat`).
  `resolveProviderAndModel` picks gemini when a key is present, else ollama.
  `toLlmToolDeclarations` converts the canonical Gemini-typed declarations to
  a provider-agnostic schema so tool behavior is uniform across providers.
- `src/server/tools.ts` — `executeAgentTool` + `agentToolDeclarations`.
  Booking/orders are transactional with overlap/oversell prevention.
- `src/server/readiness.ts` — `computeAgentReadiness` / `assertActivatable`
  (Phase 20, 12-check composite gate; ACTIVE blocked server-side).
- `src/server/security.ts` — `requestId`, `rateLimit`, `secureHeaders` (Phase 22).
- `src/server/agentVersions.ts` — DRAFT/TESTING/PUBLISHED/ARCHIVED lifecycle. `publishVersion()` runs the evaluation publish gate (`assertPublishClear`).
- `src/server/evaluation.ts` — Agent Evaluation Engine: `runEvaluation` (execute scenarios against the real runtime, deterministic scoring, structured failure classification, persist), `scoreScenario` (pure scorer), `getLatestEvaluation`/`listEvaluationsForAgent` (tenant-scoped reads), `assertPublishClear` (publish gate), `initEvaluationTable` (self-healing table). Optional LLM judge through the provider abstraction (free-first).
- `src/server/correction.ts` — Agent Self-Correction Loop: `runSelfCorrection` (read eval failures → deterministic `proposeCorrection` mapping → apply to a NEW draft → re-evaluate → pass/human-review, bounded by `MAX_CORRECTION_ATTEMPTS`), `proposeCorrection`/`applyProposalToConfig` (pure, safe, never fabricates tools/knowledge, never weakens safety), `llmSuggestInstruction` (free-first + sanitized instruction phrasing), `listCorrectionsForAgent`/`getLatestCorrectionForVersion` (tenant-scoped reads), `initCorrectionTable` (self-healing table).
- `src/components/FactoryControlCenter.tsx` — Factory Control Center UI (container `FactoryControlCenter` fetches + calls the real evaluate/correct/publish APIs; presentational `ControlCenterView` renders version/status, evaluation results + failure categories, correction attempts, human-review banner, publish-blocked reason, published status). Never implements authorization/publish rules — server gates authoritative.
- `src/components/controlCenterLogic.ts` — pure DISPLAY helpers for the control center (`summarizeEvaluation`, `publishGateHint`, `summarizeCorrection`, `requiresHumanReview`, `correctionActionLabel`, `isAutoSafeProposal`, `failureCategoryBadge`). Display-only; never a gate. Unit-tested in node env.
- `src/server/embeddings.ts` — RAG embeddings via the provider abstraction
  (`resolveEmbeddingProvider`: free-first Ollama `nomic-embed-text` or optional
  Gemini `text-embedding-004`) + keyword fallback. Each stored vector records
  its model; retrieval only compares same-model vectors (no cross-model cosine).
  `initEmbeddingsTable` self-heals the `model` column onto pre-existing tables.
- `src/server/llmProvider.ts` — **FREE-FIRST provider abstraction**.
  `LlmProvider` interface + `GeminiLlmProvider` (optional cloud) and
  `OllamaLlmProvider` (local/open-source, OpenAI-compatible `/api/chat`).
  `resolveProviderAndModel` picks gemini when a key is present, else ollama.
  `toLlmToolDeclarations` converts the canonical Gemini-typed declarations to
  a provider-agnostic schema so tool behavior is uniform across providers.
  Also exports `EmbeddingProvider` + `resolveEmbeddingProvider`/
  `embeddingProviderAvailable` for the RAG pipeline (Ollama `/api/embeddings`).
- `src/server/integrations.ts` — `IntegrationProvider` abstraction (Google/Meta/Twilio/Voice) + encrypted credential store (async, tenant-scoped, persisted to DB) + `runValidation` (only path to CONNECTED).
- `src/server/credentialCrypto.ts` — AES-256-GCM encrypt/decrypt for integration credentials + env key resolution (`INTEGRATION_ENCRYPTION_KEY` else `SESSION_SECRET`-derived via HKDF); never stores plaintext.
- `src/server/appointmentEngine.ts` — centralized scheduling: hours/holiday/notice/buffer/staff validation + slot generation (shared by REST API + agent tool).
- `src/server/webhooks.ts` — Meta/Instagram + Twilio webhook router (signature verification, idempotent, missed-call AI receptionist). Mounted at `/api/webhooks` before global body parsers.
- `src/server/telemetry.ts` — Usage Monitoring + Observability: records REAL runtime/tool/eval/correction/publish events (server-side only; LLM never writes), tenant-scoped, safe summaries (never secrets/args). `listTelemetryEvents` / `computeMetrics` / `countTelemetry`.
- `src/server/widgetSecurity.ts` — per-business widget origin allow-list + CORS header builder.
- `public/widget.js` — embeddable chat widget; derives `apiOrigin` from script src for cross-origin embedding.

## Required vs optional env vars (see .env.example)
- REQUIRED: `SESSION_SECRET` (production refuses to start without it), `DB_PATH`.
- OPTIONAL: `GEMINI_API_KEY`, `OLLAMA_BASE_URL`, `OLLAMA_DEFAULT_MODEL`, `OLLAMA_EMBEDDING_MODEL`, `EMBEDDING_PROVIDER`, `GOOGLE_*`, `META_*`, `TWILIO_*`, `VOICE_AI_*`. Absence => NOT_CONFIGURED / graceful fallback; app still starts.

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
The DB layer is fully async. All `Collection` methods (`find`, `filter`, `push`,
`update`, `length`, `toJSON`, etc.) return Promises — always `await` them.
Transactions use the async wrapper `db.client.transaction(async () => {...})`
(BEGIN/COMMIT/ROLLBACK). Do NOT use `db.sqlite.transaction()` (sync) — it cannot
wrap async bodies and is deprecated.

`SqliteClient.transaction` serializes concurrent transactions on a per-connection
mutex (SQLite is single-writer and disallows nested BEGIN), so two awaited
transactions under `Promise.all` run strictly one after another. This is what
makes the overlap/oversell tests deterministic: the second transaction sees the
first's committed write. `PostgresClient.transaction` checks out a dedicated
pool client per transaction, so concurrent transactions run in parallel.

TS narrowing note: `.transaction` widens literal `ok` types, so use the
`isFail()` type guard in tools.ts instead of `if (!r.ok)`.

## DB initialization
The singleton `db` (`src/server/db.ts`) is constructed at import but NOT
migrated/seeded until `await db.init()` runs. `server.ts` calls
`await db.init()` at startup. Tests that import the singleton must call
`await db.init()` in `beforeAll` (and `await db.close()` in `afterAll`) before
touching the routes. Constructing `new AppDatabase({...})` directly also
requires `await instance.init({ seed })` before use.

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
  In dev a fixed fallback secret is used. If missing in prod, login returns a
  clean JSON 500 (per-request; the server still starts).
- `GEMINI_API_KEY` — optional; runtime degrades gracefully.
- Optional integrations (Google/Meta/Twilio/Voice) — not yet wired; must NOT
  block startup when absent.
