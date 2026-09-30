// A small Cloudflare D1 stand-in over node:sqlite for local runs and tests (never deployed).
// It covers what the Worker uses: prepare(sql).bind(...).run() / .all() / .first(col?) / .raw(),
// and db.batch([...]) as one transaction that rolls back on any failure, like D1.
// Like D1, binding undefined is an error; booleans are stored as 1/0.
import { DatabaseSync } from 'node:sqlite';

const RETURNS_ROWS = /^\s*(select|pragma|with|values)\b|\breturning\b/i;

function toValue(value) {
  if (value === undefined) throw new TypeError('D1_TYPE_ERROR: Type undefined is not supported');
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

export function createD1(sqlite) {
  const exec = (sql, values) => {
    const statement = sqlite.prepare(sql);
    if (RETURNS_ROWS.test(sql)) {
      const rows = statement.all(...values).map(row => ({ ...row }));
      return { results: rows, success: true, meta: { changes: /returning/i.test(sql) ? rows.length : 0, rows_read: rows.length } };
    }
    const info = statement.run(...values);
    return { results: [], success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
  };
  const bound = (sql, values) => ({
    sql,
    values,
    bind(...next) { return bound(sql, next.map(toValue)); },
    async run() { return exec(sql, values); },
    async all() { return exec(sql, values); },
    async first(column) {
      const row = exec(sql, values).results[0] ?? null;
      if (column === undefined || row === null) return row;
      return row[column] ?? null;
    },
    async raw() { return exec(sql, values).results.map(row => Object.values(row)); }
  });
  return {
    sqlite,
    prepare(sql) { return bound(sql, []); },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map(statement => exec(statement.sql, statement.values));
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    async exec(sql) { sqlite.exec(sql); return { count: 1 }; }
  };
}

// An in-memory or file database with the drizzle migrations applied (the scores table etc.).
export function openDatabase(file = ':memory:', migrationsDir = null, fs = null) {
  const sqlite = new DatabaseSync(file);
  if (migrationsDir && fs) {
    sqlite.exec('CREATE TABLE IF NOT EXISTS preview_migrations (name TEXT PRIMARY KEY)');
    for (const name of fs.readdirSync(migrationsDir).filter(entry => entry.endsWith('.sql')).sort()) {
      if (sqlite.prepare('SELECT name FROM preview_migrations WHERE name = ?').get(name)) continue;
      sqlite.exec('BEGIN');
      try {
        sqlite.exec(fs.readFileSync(migrationsDir + '/' + name, 'utf8'));
        sqlite.prepare('INSERT INTO preview_migrations VALUES (?)').run(name);
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  }
  return sqlite;
}
