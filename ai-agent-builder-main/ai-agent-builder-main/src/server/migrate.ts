import { AppDatabase } from './db';

// Applies pending migrations (and leaves seeding to normal server startup).
const appDb = new AppDatabase({ seed: false });
console.log(`[migrate] SQLite ready at ${appDb.dbPath}`);
console.log(`[migrate] Pending migrations applied. Tables: ${(appDb.sqlite.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as { c: number } | undefined)?.c ?? 0}`);
appDb.close();
