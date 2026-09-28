/**
 * sqlite.js — opens the database.
 *
 * Three ways to run, picked automatically:
 *
 *  1. TURSO_DATABASE_URL is set  →  the database lives on Turso, a hosted
 *     SQLite service with a free tier. This is what you use on free hosting
 *     (Render, etc.) where the server's own disk is wiped on every restart.
 *     Driver: the `libsql` package, which speaks the same API as better-sqlite3.
 *
 *  2. Otherwise, a local file data/shop.db using the SQLite built into Node
 *     itself (Node 22.13 or newer) — nothing to compile, nothing to install.
 *
 *  3. If you have installed the optional `better-sqlite3` package
 *     (npm install better-sqlite3), it is used for the local file instead.
 *
 * The rest of the app cannot tell the difference between the three.
 */

const TURSO_URL = process.env.TURSO_DATABASE_URL || '';

let Database;

if (TURSO_URL) {
  Database = buildTurso();
} else {
  try {
    Database = require('better-sqlite3');
  } catch {
    Database = buildBuiltin();
  }
}

/* -------------------------------------------------------------------- */

function buildTurso() {
  let Libsql;
  try {
    Libsql = require('libsql');
  } catch (err) {
    console.error(
      '\n  TURSO_DATABASE_URL is set but the "libsql" package is not installed.\n' +
        '  Run "npm install" again (it is listed in package.json).\n  ' +
        err.message +
        '\n'
    );
    process.exit(1);
  }

  const token = process.env.TURSO_AUTH_TOKEN || '';
  if (!token) {
    console.warn('[db] TURSO_AUTH_TOKEN is empty — the connection will probably be refused.');
  }
  console.log('[db] Using Turso at ' + TURSO_URL.replace(/^libsql:\/\//, ''));

  /**
   * Same surface as better-sqlite3, but every statement runs on Turso.
   *
   * Two things about the remote protocol are handled here so the rest of the
   * app never sees them:
   *
   *  - Turso closes an idle connection after ~10 seconds. The next request on
   *    it fails with STREAM_EXPIRED and the driver does not recover on its
   *    own, so we reconnect once and retry. The failed request was rejected
   *    before it ran, so retrying is safe.
   *  - A statement prepared *outside* a transaction and run *inside* one
   *    makes the driver close the connection mid-transaction. So statements
   *    are prepared at the moment they run, never ahead of time.
   *
   * `pragma()` is not supported for remote databases in libsql, so it is a
   * no-op here — WAL mode is Turso's problem, not ours.
   */
  const RECONNECT = /STREAM_EXPIRED|baton|stream has expired/i;

  return class TursoDatabase {
    constructor(/* file path is ignored: the data is remote */) {
      this._connect();
    }
    _connect() {
      this._db = new Libsql(TURSO_URL, { authToken: token }); // no network cost
    }
    _retry(fn) {
      try {
        return fn();
      } catch (err) {
        if (!RECONNECT.test(String(err && err.message))) throw err;
        console.warn('[db] Turso connection had expired — reconnecting.');
        this._connect();
        return fn();
      }
    }
    pragma() {
      return [];
    }
    exec(sql) {
      return this._retry(() => this._db.exec(sql));
    }
    prepare(sql) {
      return {
        run: (...a) => this._retry(() => this._db.prepare(sql).run(...a)),
        get: (...a) => this._retry(() => this._db.prepare(sql).get(...a)),
        all: (...a) => this._retry(() => this._db.prepare(sql).all(...a)),
      };
    }
    transaction(fn) {
      return (...args) => {
        this.exec('BEGIN');
        try {
          const result = fn(...args);
          this.exec('COMMIT');
          return result;
        } catch (err) {
          try {
            this.exec('ROLLBACK');
          } catch {
            /* the connection may already be gone; the error below matters more */
          }
          throw err;
        }
      };
    }
    close() {
      return this._db.close();
    }
  };
}

function buildBuiltin() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    console.error(
      '\n  Could not open a database: this version of Node (' + process.version + ')\n' +
        '  has no built-in SQLite. Install Node 22.13 or newer from https://nodejs.org\n' +
        '  (or run "npm install better-sqlite3" to use that instead).\n'
    );
    process.exit(1);
  }

  /** The slice of the better-sqlite3 API this project uses. */
  return class BuiltinDatabase {
    constructor(file) {
      this._db = new DatabaseSync(file);
    }
    pragma(statement) {
      return this._db.exec('PRAGMA ' + statement);
    }
    exec(sql) {
      return this._db.exec(sql);
    }
    prepare(sql) {
      const st = this._db.prepare(sql);
      return {
        run: (...args) => st.run(...args),
        get: (...args) => st.get(...args),
        all: (...args) => st.all(...args),
      };
    }
    transaction(fn) {
      const db = this._db;
      return (...args) => {
        db.exec('BEGIN');
        try {
          const result = fn(...args);
          db.exec('COMMIT');
          return result;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      };
    }
    close() {
      this._db.close();
    }
  };
}

module.exports = Database;
