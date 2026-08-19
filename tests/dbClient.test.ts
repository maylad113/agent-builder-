import { describe, it, expect } from 'vitest';
import { splitStatements, stripForUpdate } from '../src/server/dbClient';

/**
 * Unit tests for the SQL script splitter used by the PostgreSQL client's
 * execMany() (migrations). Regression coverage for the fresh-PG-init bug:
 * the splitter used to break statements on `;` inside `--` comments, producing
 * fragments like `when pgvector ...` that PostgreSQL rejects with a syntax
 * error — so a fresh PostgreSQL database could not be migrated at all.
 */
describe('splitStatements', () => {
  it('splits plain statements on top-level semicolons', () => {
    const stmts = splitStatements('CREATE TABLE a (id TEXT); CREATE TABLE b (id TEXT);');
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('CREATE TABLE a');
    expect(stmts[1]).toContain('CREATE TABLE b');
  });

  it('ignores semicolons inside single-quoted strings', () => {
    const stmts = splitStatements(`INSERT INTO t VALUES ('a;b'); SELECT 1;`);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain(`'a;b'`);
  });

  it('handles escaped single quotes inside strings', () => {
    const stmts = splitStatements(`INSERT INTO t VALUES ('it''s; ok'); SELECT 2;`);
    expect(stmts).toHaveLength(2);
  });

  it('ignores semicolons inside double-quoted identifiers', () => {
    const stmts = splitStatements(`CREATE TABLE "weird;name" (id TEXT); SELECT 3;`);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('"weird;name"');
  });

  it('ignores semicolons inside -- line comments (fresh-PG-init regression)', () => {
    const sql = [
      '-- app works without the extension; when pgvector is present the embeddings',
      'CREATE TABLE t (id TEXT);',
      '-- trailing comment; with semicolon',
      'SELECT 1;',
    ].join('\n');
    const stmts = splitStatements(sql);
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain('CREATE TABLE t');
    expect(stmts[1]).toContain('SELECT 1');
  });

  it('ignores semicolons inside /* block comments */', () => {
    const stmts = splitStatements('/* header; comment */\nCREATE TABLE t (id TEXT);\nSELECT 4;');
    expect(stmts).toHaveLength(2);
  });

  it('handles a comment line that ends at EOF without newline', () => {
    const stmts = splitStatements('SELECT 1; -- done; really done');
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain('SELECT 1');
  });

  it('drops fragments that contain only comments or whitespace', () => {
    const stmts = splitStatements('-- just a comment;\n/* only this; */\nSELECT 5;');
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain('SELECT 5');
  });

  it('splits the real PG migration scripts into executable statements (no bare comment fragments)', () => {
    // Guard against regression using the actual migration files that broke init.
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const pgDir = path.join(process.cwd(), 'migrations', 'pg');
    for (const file of fs.readdirSync(pgDir).filter(f => f.endsWith('.sql'))) {
      const stmts = splitStatements(fs.readFileSync(path.join(pgDir, file), 'utf8'));
      expect(stmts.length).toBeGreaterThan(0);
      for (const s of stmts) {
        // Strip leading comment lines: a statement may legitimately carry its
        // comment header. What must never happen is a fragment whose first SQL
        // token is a mid-comment word like `when` (the fresh-init bug).
        const code = s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
        expect(code.length).toBeGreaterThan(0);
        const first = code.split(/\s+/)[0]?.toUpperCase();
        expect(['CREATE', 'INSERT', 'ALTER', 'DROP', 'UPDATE', 'DELETE', 'SELECT', 'BEGIN', 'COMMIT', 'DO', 'GRANT', 'REVOKE', 'SET', 'COMMENT', 'WITH']).toContain(first);
      }
    }
  });
});

describe('stripForUpdate', () => {
  it('strips a trailing FOR UPDATE (SQLite portability)', () => {
    expect(stripForUpdate('SELECT * FROM t WHERE id = ? FOR UPDATE')).toBe('SELECT * FROM t WHERE id = ?');
    expect(stripForUpdate('SELECT 1 FOR UPDATE NOWAIT')).toBe('SELECT 1');
    expect(stripForUpdate('SELECT 1 FOR UPDATE SKIP LOCKED')).toBe('SELECT 1');
  });

  it('leaves statements without FOR UPDATE untouched', () => {
    expect(stripForUpdate('SELECT * FROM t')).toBe('SELECT * FROM t');
  });
});
