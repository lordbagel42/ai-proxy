import { chmodSync, closeSync, existsSync, linkSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

type Row = Record<string, unknown>;

function databaseError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("D1_")) return error;
  return new Error(`D1_ERROR: ${error instanceof Error ? error.message : "SQLite operation failed"}`, { cause: error });
}

function input(value: unknown): SQLInputValue {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (Array.isArray(value) && value.every((entry) => Number.isInteger(entry) && entry >= 0 && entry <= 255)) return new Uint8Array(value);
  // D1 accepts numbers, strings, null and byte buffers; callers must map booleans to 0/1.
  throw new Error("D1_TYPE_ERROR: unsupported bind value");
}

function output(value: SQLOutputValue): unknown {
  return value instanceof Uint8Array ? Array.from(value) : value;
}

function leadingSql(sql: string): string {
  return sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "");
}

export class LocalStatement {
  readonly database: LocalDatabase;
  readonly sql: string;
  readonly values: SQLInputValue[];
  constructor(database: LocalDatabase, sql: string, values: SQLInputValue[] = []) {
    this.database = database;
    this.sql = sql;
    this.values = values;
  }

  bind(...values: unknown[]): LocalStatement {
    return new LocalStatement(this.database, this.sql, values.map(input));
  }

  async first<T = Row>(column?: string): Promise<T | null> {
    const row = this.database.execute<Row>(this).result.results[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!Object.hasOwn(row, column)) throw new Error("D1_COLUMN_NOTFOUND: column does not exist");
    return row[column] as T;
  }

  async all<T = Row>(): Promise<D1Result<T>> { return this.database.execute<T>(this).result; }
  async run<T = Row>(): Promise<D1Result<T>> { return this.database.execute<T>(this).result; }

  async raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const { columns, rows } = this.database.execute(this);
    return options?.columnNames ? [columns, ...rows as T[]] : rows as T[];
  }
}

/** A single-process D1-compatible binding. Each batch executes synchronously in one SQLite transaction. */
export class LocalDatabase {
  /** Maintenance helpers use the native connection synchronously; application queries use the D1 methods. */
  readonly sqlite: DatabaseSync;
  private closed = false;
  private readonly readOnly: boolean;

  constructor(path: string, options: { create?: boolean; readOnly?: boolean } = {}) {
    if (path !== ":memory:" && !options.create && !existsSync(path)) throw new Error("Database does not exist; initialize or import it explicitly before starting the server");
    this.readOnly = options.readOnly ?? false;
    this.sqlite = new DatabaseSync(path, { readOnly: options.readOnly ?? false, enableForeignKeyConstraints: true, timeout: 5_000 });
    try {
      if (!options.readOnly) this.sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      this.sqlite.exec("PRAGMA foreign_keys = ON;");
    } catch (error) {
      this.sqlite.close();
      throw error;
    }
  }

  prepare(sql: string): LocalStatement { return new LocalStatement(this, sql); }

  /** This cast is confined to the compatibility boundary; the application only uses implemented D1 methods. */
  asD1Database(): D1Database { return this as unknown as D1Database; }

  execute<T = Row>(query: LocalStatement): { result: D1Result<T>; columns: string[]; rows: unknown[][] } {
    try {
      if (query.database !== this) throw new Error("Prepared statement belongs to another database");
      if (/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(leadingSql(query.sql))) throw new Error("Use DB.batch() for transactions");
      const start = performance.now();
      const before = this.sqlite.prepare("SELECT total_changes() AS changes").get()!.changes as number;
      const statement = this.sqlite.prepare(query.sql);
      const remainder = leadingSql(query.sql.slice(statement.sourceSQL.length));
      if (remainder) throw new Error("Only one SQL statement is allowed in prepare()");
      const columns = statement.columns().map((column) => column.name);
      statement.setReturnArrays(true);
      // all() drains RETURNING statements. get() could leave a write unfinished after its first row.
      const rows = (statement.all(...query.values) as unknown as SQLOutputValue[][]).map((row) => row.map(output));
      const stats = this.sqlite.prepare("SELECT total_changes() AS total, changes() AS changes, last_insert_rowid() AS last_row_id").get()!;
      const written = Number(stats.total) - before;
      const pages = this.sqlite.prepare("PRAGMA page_count").get()!.page_count as number;
      const pageSize = this.sqlite.prepare("PRAGMA page_size").get()!.page_size as number;
      return {
        columns, rows,
        result: {
          success: true,
          results: rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))) as T[],
          meta: {
            duration: performance.now() - start,
            // Node exposes changes, not SQLite's virtual-machine row-scan counters. These are local estimates.
            rows_read: rows.length, rows_written: written, size_after: pages * pageSize,
            changes: written ? Number(stats.changes) : 0, last_row_id: Number(stats.last_row_id), changed_db: written > 0,
            served_by: "node:sqlite",
          },
        },
      };
    } catch (error) { throw databaseError(error); }
  }

  async batch<T = unknown>(statements: LocalStatement[]): Promise<D1Result<T>[]> {
    if (!statements.length) return [];
    try {
      if (statements.some((statement) => !(statement instanceof LocalStatement) || statement.database !== this)) throw new Error("Batch contains a statement from another database");
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => this.execute<T>(statement).result);
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    } catch (error) { throw databaseError(error); }
  }

  async exec(sql: string): Promise<D1ExecResult> {
    const start = performance.now();
    let count = 0;
    let remaining = leadingSql(sql);
    try {
      // SQLite determines each statement boundary, including trigger bodies and quoted semicolons.
      while (remaining) {
        const statement = this.sqlite.prepare(remaining);
        if (!statement.sourceSQL) break;
        this.execute(this.prepare(statement.sourceSQL));
        remaining = leadingSql(remaining.slice(statement.sourceSQL.length));
        count++;
      }
      return { count, duration: performance.now() - start };
    } catch (error) { throw databaseError(error); }
  }

  checkpoint(): void {
    if (this.closed || this.readOnly) return;
    const result = this.sqlite.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (result && Number(result.busy) !== 0) throw new Error("SQLite checkpoint is busy; another connection still holds the database");
  }

  close(): void {
    if (this.closed) return;
    try { this.checkpoint(); }
    finally { this.sqlite.close(); this.closed = true; }
  }
}

export function createDatabase(path: string, options: { create?: boolean; readOnly?: boolean } = {}): LocalDatabase {
  return new LocalDatabase(path, options);
}

const migrationTableSql = `CREATE TABLE IF NOT EXISTS d1_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
)`;

function migrations(directory: string): { name: string; sql: string }[] {
  const names = readdirSync(directory).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
  if (!names.length) throw new Error("No application migrations found");
  return names.map((name) => ({ name, sql: readFileSync(resolve(directory, name), "utf8") }));
}

function hasTable(db: LocalDatabase, name: string): boolean {
  return !!db.sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
}

function quoteIdentifier(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

function checkIntegrity(db: LocalDatabase): void {
  const integrity = db.sqlite.prepare("PRAGMA integrity_check").all();
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok") throw new Error("Database integrity check failed");
  const violations = db.sqlite.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) throw new Error(`Database has ${violations.length} foreign key violation(s)`);
}

function checkLedger(db: LocalDatabase, names: string[], complete: boolean): string[] {
  if (!hasTable(db, "d1_migrations")) throw new Error("Database migration ledger is missing; import the D1 export using db-cli first");
  const applied = db.sqlite.prepare("SELECT name FROM d1_migrations ORDER BY name").all().map((row) => String(row.name));
  if (applied.some((name, index) => name !== names[index])) throw new Error("Database migration ledger is inconsistent with this application version");
  if (complete && applied.length !== names.length) throw new Error("Database has pending migrations; run db-cli migrate before starting the server");
  return applied;
}

function checkSchema(db: LocalDatabase, files: { name: string; sql: string }[]): void {
  const expected = createDatabase(":memory:");
  try {
    for (const file of files) expected.sqlite.exec(file.sql);
    const tables = expected.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    for (const table of tables) {
      const name = String(table.name);
      if (!hasTable(db, name)) throw new Error(`Database is missing required table ${name}`);
      // Checking structure avoids depending on the formatting used by SQLite's SQL exporter.
      for (const pragma of ["table_info", "foreign_key_list", "index_list"]) {
        const normalize = (rows: Record<string, SQLOutputValue>[]) => rows.map((row) => {
          const value = { ...row };
          if (pragma === "index_list") delete value.seq;
          if (typeof value.dflt_value === "string") value.dflt_value = value.dflt_value.replace(/\s+/g, " ").trim();
          return value;
        }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        const query = `PRAGMA ${pragma}(${quoteIdentifier(name)})`;
        if (JSON.stringify(normalize(db.sqlite.prepare(query).all())) !== JSON.stringify(normalize(expected.sqlite.prepare(query).all()))) {
          throw new Error(`Database schema mismatch for ${name} (${pragma})`);
        }
      }
      const indexes = expected.sqlite.prepare(`PRAGMA index_list(${quoteIdentifier(name)})`).all();
      for (const index of indexes) {
        const query = `PRAGMA index_xinfo(${quoteIdentifier(String(index.name))})`;
        if (JSON.stringify(db.sqlite.prepare(query).all()) !== JSON.stringify(expected.sqlite.prepare(query).all())) throw new Error(`Database index mismatch for ${String(index.name)}`);
      }
    }
  } finally { expected.close(); }
}

/** Runs before listening. Imported credentials remain opaque and are never logged. */
export function validateDatabase(db: LocalDatabase, migrationsDirectory = "migrations"): void {
  const files = migrations(migrationsDirectory);
  checkIntegrity(db);
  checkLedger(db, files.map((file) => file.name), true);
  checkSchema(db, files);
}

/** Offline operation: apply all pending migrations and their ledger entries atomically. */
export function migrateDatabase(db: LocalDatabase, migrationsDirectory = "migrations"): string[] {
  const files = migrations(migrationsDirectory);
  checkIntegrity(db);
  if (!hasTable(db, "d1_migrations")) {
    const existing = db.sqlite.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get()!;
    if (Number(existing.count)) throw new Error("Existing database has no migration ledger; use db-cli import to validate and adopt a D1 export");
  }
  db.sqlite.exec("BEGIN IMMEDIATE");
  try {
    db.sqlite.exec(migrationTableSql);
    const applied = checkLedger(db, files.map((file) => file.name), false);
    const pending = files.slice(applied.length);
    db.sqlite.exec("PRAGMA defer_foreign_keys = ON");
    for (const file of pending) {
      db.sqlite.exec(file.sql);
      db.sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file.name);
    }
    checkIntegrity(db);
    checkSchema(db, files);
    db.sqlite.exec("COMMIT");
    return pending.map((file) => file.name);
  } catch (error) {
    db.sqlite.exec("ROLLBACK");
    throw error;
  }
}

function publishNewDatabase(destination: string, initialize: (db: LocalDatabase) => void): void {
  if ([destination, `${destination}-wal`, `${destination}-shm`, `${destination}-journal`].some(existsSync)) throw new Error("Destination already exists; refusing to overwrite a database or its journal");
  const temporary = `${destination}.import-${randomUUID()}`;
  closeSync(openSync(temporary, "wx", 0o600));
  let db: LocalDatabase | undefined;
  try {
    db = createDatabase(temporary);
    initialize(db);
    db.close();
    db = undefined;
    chmodSync(temporary, 0o600);
    // An atomic link has no overwrite behavior, unlike rename. A failed import never becomes visible at destination.
    linkSync(temporary, destination);
  } finally {
    try { db?.close(); }
    finally {
      for (const path of [temporary, `${temporary}-wal`, `${temporary}-shm`, `${temporary}-journal`]) rmSync(path, { force: true });
    }
  }
}

export function initializeDatabase(destination: string, migrationsDirectory = "migrations"): void {
  publishNewDatabase(destination, (db) => { migrateDatabase(db, migrationsDirectory); validateDatabase(db, migrationsDirectory); });
}

/** Imports a trusted Wrangler D1 SQL export into a NEW database, never over an active database. */
export function importDatabase(sqlPath: string, destination: string, migrationsDirectory = "migrations"): void {
  const sql = readFileSync(sqlPath, "utf8");
  publishNewDatabase(destination, (db) => {
    // D1's export may list child tables before parents. Enforce all relationships once loading is complete.
    db.sqlite.exec("PRAGMA foreign_keys = OFF");
    db.sqlite.exec(sql);
    if (db.sqlite.isTransaction) db.sqlite.exec("COMMIT");
    const internals = db.sqlite.prepare("SELECT type, name FROM sqlite_schema WHERE name GLOB '_cf_*' AND type IN ('table', 'view', 'trigger') ORDER BY type DESC").all();
    for (const object of internals) db.sqlite.exec(`DROP ${String(object.type).toUpperCase()} IF EXISTS ${quoteIdentifier(String(object.name))}`);
    db.sqlite.exec("PRAGMA foreign_keys = ON");
    const files = migrations(migrationsDirectory);
    if (!hasTable(db, "d1_migrations")) {
      // Some D1 exports omit the Wrangler ledger. Adopt only a proven complete current schema.
      checkIntegrity(db);
      checkSchema(db, files);
      db.sqlite.exec(migrationTableSql);
      for (const file of files) db.sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file.name);
    }
    migrateDatabase(db, migrationsDirectory);
    validateDatabase(db, migrationsDirectory);
  });
}
