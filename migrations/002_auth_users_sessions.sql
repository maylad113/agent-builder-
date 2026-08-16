-- 002_auth_users_sessions.sql
-- Real server-side authentication: users + server-side sessions.
--
-- users.role: PLATFORM_OWNER | BUSINESS_OWNER | BUSINESS_STAFF
-- users.business_id is NULL only for the platform owner. Business owners and
-- staff are hard-scoped to exactly one tenant; the server derives the
-- authorized tenant from the SESSION, never from frontend-supplied values.
--
-- sessions: server-side session records so sessions survive server restarts
-- and logout truly invalidates (row deleted). The browser only holds a signed
-- HttpOnly cookie containing the session id + HMAC signature.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,                    -- scrypt: scrypt$N$r$p$salt$hash
  name          TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL CHECK (role IN ('PLATFORM_OWNER', 'BUSINESS_OWNER', 'BUSINESS_STAFF')),
  business_id   TEXT REFERENCES businesses(id),   -- NULL only for PLATFORM_OWNER
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_users_business_id ON users(business_id);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
