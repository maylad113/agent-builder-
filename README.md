# AI Agent Factory

A multi-tenant SaaS platform for building, testing, deploying, and operating AI
customer-service agents for real businesses. One platform runtime powers many
independent business agents — each with completely isolated data, customers,
conversations, knowledge, tools, credentials, appointments, orders, and analytics.

```
PLATFORM OWNER
  → Create Business
  → AI generates a proposed agent (fact-safe, never invents business data)
  → Human reviews configuration
  → Add knowledge / tools / channels
  → Test in simulator
  → Publish + activate
  → Real customers interact via the website widget / Instagram / SMS
  → Agent answers, searches knowledge, books appointments, escalates to humans
  → Business owner sees everything in the dashboard
```

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Copy environment config (only SESSION_SECRET is required for production)
cp .env.example .env

# 3. Development server (Vite dev + Express, hot reload)
npm run dev
#   → frontend on http://localhost:5173
#   → API on http://localhost:3000

# 4. Or: production build + run
npm run build
export SESSION_SECRET="$(openssl rand -hex 32)"   # REQUIRED in production
npm start
#   → serves frontend + API on http://localhost:3000
```

The database (SQLite) and migrations are created automatically on first boot —
no manual migration step is required.

## Default login

| Email | Password | Role |
|---|---|---|
| `owner@agentfactory.io` | `Password123!` | Platform Owner (create businesses, duplicate templates) |
| `tony@tonysbarber.com` | `Password123!` | Business Owner (Tony's Barber demo) |
| `staff@tonysbarber.com` | `Password123!` | Business Staff |

Change these in production by seeding different users (see `src/server/db.ts`).

## Testing

```bash
npx tsc --noEmit      # typecheck
npm test              # unit + integration suite (112 tests)
npm run build         # production build smoke

# End-to-end production smoke (server must be running on :3999)
SESSION_SECRET=... DB_PATH=/tmp/prod.db NODE_ENV=production PORT=3999 npm start &
PORT=3999 bash scripts/e2e-smoke.sh
```

The E2E smoke harness exercises the full Phase 25 scenario: login → create
business → generate agent → add knowledge → book appointment → verify DB →
cancel → publish → activate → widget chat (allowed + disallowed origin) →
tenant isolation. 18/18 checks must pass.

## Embedding the chat widget

Add this to any business website:

```html
<script src="https://your-platform.example/widget.js" data-business-id="biz-..."></script>
```

Configure the allowed origins for each business in the dashboard so only the
business's own site can load the widget (CORS + Origin enforcement, enforced
server-side in production).

## Environment variables

Only **two** are required to run the core platform. Everything else is optional
and only needed when you enable that integration — the app never refuses to
start because an optional credential is missing.

| Variable | Required? | Purpose |
|---|---|---|
| `SESSION_SECRET` | **Yes (prod)** | Signs session cookies. Generate a 32+ char random string. |
| `DB_PATH` | No | SQLite database file (default `./data/agentfactory.db`). |
| `PORT` | No | Server port (default 3000). |
| `NODE_ENV` | No | `production` serves built frontend + requires real `SESSION_SECRET`. |
| `GEMINI_API_KEY` | No | LLM responses + embeddings. Without it, chat escalates to human and RAG falls back to keyword search. |
| `GOOGLE_CLIENT_ID` / `SECRET` / `REDIRECT_URI` | No | Google Calendar sync. |
| `META_APP_ID` / `SECRET` / `VERIFY_TOKEN` | No | Instagram Business messaging. |
| `TWILIO_ACCOUNT_SID` / `AUTH_TOKEN` / `PHONE_NUMBER` | No | Telephony + SMS missed-call receptionist. |
| `VOICE_AI_API_KEY` / `ENDPOINT` | No | Voice AI provider. |

See `.env.example` for the full list with comments.

## Architecture

```
server.ts                      Express entry; graceful shutdown; Vite dev / static prod
src/
  server/
    routes.ts                 REST API (auth, businesses, agents, knowledge,
                               appointments, orders, conversations, integrations,
                               analytics, audit) — all tenant-scoped
    db.ts                      SQLite repository layer (better-sqlite3, WAL)
    migrate.ts                 idempotent SQL migrations (auto-applied on boot)
    auth.ts                    session auth, bcrypt, tenant scope, IDOR guards
    agentRuntime.ts            tool-loop LLM runtime; published-version gating
    agentVersions.ts           DRAFT → TESTING → PUBLISHED → ARCHIVED lifecycle
    tools.ts                   12 server-validated tools (book, cancel, reschedule,
                               search/get products, create_order, order status,
                               notify owner, transfer to human, …)
    appointmentEngine.ts       timezone-aware scheduling: hours, holidays, notice,
                               buffers, staff, overlap prevention (transactional)
    webhooks.ts                Meta (signature verify) + Twilio (HMAC) inbound,
                               missed-call receptionist, idempotency
    integrations.ts            provider abstraction (Google/Meta/Twilio/Voice);
                               CONNECTED only after real provider validation
    embeddings.ts              Gemini embeddings + keyword fallback (RAG)
    readiness.ts               deployment readiness checklist + activation gate
    security.ts                request IDs, rate limiting, secure headers
    widgetSecurity.ts          per-business origin allow-list, CORS
  (frontend)                  React + Vite SPA: dashboard, agent builder,
                               simulator, conversations, analytics
migrations/                    SQL migration files
public/widget.js               embeddable chat widget
tests/                         112 unit + integration + security tests
scripts/e2e-smoke.sh           production E2E harness
```

## Security model

- **Authentication**: session cookies, HttpOnly + Secure (prod), signed with `SESSION_SECRET`.
- **Authorization**: roles `PLATFORM_OWNER`, `BUSINESS_OWNER`, `BUSINESS_STAFF`.
- **Tenant isolation**: every business-owned query is scoped from the
  authenticated session — `businessId` / `agentId` / `customerId` in the request
  is **never** trusted for authorization. Cross-tenant access returns 404.
- **Tools**: the LLM can only call tools the agent is permitted to use; every
  tool call is re-validated server-side for tenant, arguments, ownership, and
  business rules. Failed bookings report failure honestly — the agent cannot
  tell a customer "booked" unless the DB write succeeded.
- **Credentials**: integration credentials stay server-side, are never returned
  to the frontend, never logged, and isolated from ordinary config data.
- **Webhooks**: Meta (X-Hub-Signature-256 HMAC) and Twilio (X-Twilio-Signature)
  signatures are verified; business is resolved server-side; duplicate webhooks
  are deduplicated (idempotency).

## Deployment

### Docker

```bash
docker build -t ai-agent-factory .
docker run -p 3000:3000 \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e GEMINI_API_KEY=... \
  -v agentforge-data:/app/data \
  ai-agent-factory
```

See `docker-compose.yml` for a one-command stack.

### Manual / VM

1. `npm ci && npm run build`
2. Set `SESSION_SECRET`, `DB_PATH` (writable path), and any integration credentials you need.
3. `npm start` (migrations auto-apply on first boot).
4. Put a TLS-terminating reverse proxy (nginx/Caddy) in front.
5. Health check: `GET /api/health` returns `200 {"status":"ok","db":"connected"}` or `503` if the DB is unreachable.

## Production upgrade path

The platform runs on SQLite (single-file, zero-config, safe for single-instance
small-business deployments). For horizontal scale or managed backups, migrate to
PostgreSQL + pgvector: the repository layer in `src/server/db.ts` is the only
DB-coupled module, and the schema in `migrations/` is standard SQL. This is the
recommended next step once you need multiple concurrent app instances.
