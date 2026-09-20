import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync, statSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { user } from "../src/db/schema";
import { createDatabase, importDatabase, initializeDatabase, migrateDatabase, validateDatabase, type LocalDatabase } from "../server/sqlite";

const directory = resolve("migrations");
const migrationNames = readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
const databases: LocalDatabase[] = [];
const temporaryDirectories: string[] = [];
function database() { const db = createDatabase(":memory:"); databases.push(db); return db; }
function temporary() { const dir = mkdtempSync(join(tmpdir(), "ai-proxy-sqlite-test-")); temporaryDirectories.push(dir); return dir; }
function schemaSql() { return readdirSync(directory).filter((name) => name.endsWith(".sql")).sort().map((name) => readFileSync(join(directory, name), "utf8")).join("\n"); }
function exportSql(includeLedger = false) {
  let sql = `PRAGMA defer_foreign_keys=TRUE;\n${schemaSql()}\n`;
  // Child-first ordering is valid in a D1 dump and must not discard existing identities or opaque credentials.
  sql += "INSERT INTO account (id,account_id,provider_id,user_id,updated_at,access_token) VALUES ('a','ident!owner','hackclub','u',123,'opaque-auth-token');\n";
  sql += "INSERT INTO user (id,name,email,updated_at) VALUES ('u','O''Connor;\nnext line','u@example.invalid',123);\n";
  sql += "INSERT INTO codex_connection (id,owner_identity,credentials,updated_at) VALUES ('codex','ident!owner','opaque-encrypted-codex-credentials',123);\n";
  sql += "CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB); INSERT INTO _cf_KV VALUES ('internal', X'0102');\n";
  if (includeLedger) {
    sql += "CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);\n";
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) sql += `INSERT INTO d1_migrations (name,applied_at) VALUES ('${name}','2026-09-19 00:00:00');\n`;
  }
  return sql;
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Node D1-compatible SQLite binding", () => {
  it("keeps bound statements independent and safely maps numbered parameters and blobs", async () => {
    const db = database();
    const statement = db.prepare("SELECT ?2 AS second, ?1 AS first, ?3 AS bytes");
    const bound = statement.bind("O'Connor; DROP TABLE user;", 42, new Uint8Array([0, 128, 255]));
    expect(await bound.first()).toEqual({ second: 42, first: "O'Connor; DROP TABLE user;", bytes: [0, 128, 255] });
    expect(await statement.bind("another", 2, [4, 5]).first("first")).toBe("another");
    expect(await bound.first("first")).toBe("O'Connor; DROP TABLE user;");
    expect(() => statement.bind(undefined)).toThrow("D1_TYPE_ERROR");
    expect(() => statement.bind(true)).toThrow("D1_TYPE_ERROR");
    expect(() => statement.bind(Number.NaN)).toThrow("D1_TYPE_ERROR");
    expect(() => statement.bind({ token: "secret" })).toThrow("unsupported bind value");
  });

  it("returns ordered raw values including duplicate column names, empty headers and first semantics", async () => {
    const db = database();
    expect(await db.prepare("SELECT 1 AS duplicate, 2 AS duplicate").raw({ columnNames: true })).toEqual([["duplicate", "duplicate"], [1, 2]]);
    expect(await db.prepare("SELECT 1 AS empty WHERE 0").raw({ columnNames: true })).toEqual([["empty"]]);
    expect(await db.prepare("SELECT 1 WHERE 0").first()).toBeNull();
    await expect(db.prepare("SELECT 1 AS actual").first("missing")).rejects.toThrow("D1_COLUMN_NOTFOUND");
    await expect(db.prepare("SELECT 1; DELETE FROM user").all()).rejects.toThrow("Only one SQL statement");
  });

  it("drains RETURNING writes and reports changes accurately after reads or no-op writes", async () => {
    const db = database();
    await db.exec("CREATE TABLE item (id INTEGER PRIMARY KEY, value TEXT)");
    const created = await db.prepare("INSERT INTO item (value) VALUES ('a'),('b'),('c') RETURNING *").run();
    expect(created.results).toHaveLength(3);
    expect(created.meta.changes).toBe(3);
    expect(created.meta.last_row_id).toBe(3);
    expect(await db.prepare("UPDATE item SET value = 'changed' RETURNING id").first("id")).toBe(1);
    expect(await db.prepare("SELECT count(*) AS count FROM item WHERE value='changed'").first("count")).toBe(3);
    expect((await db.prepare("SELECT * FROM item").all()).meta.changes).toBe(0);
    expect((await db.prepare("UPDATE item SET value='never' WHERE id=99").run()).meta.changes).toBe(0);
  });

  it("rolls back the entire batch on constraint failure and enforces foreign keys", async () => {
    const db = database();
    await db.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));");
    await expect(db.batch([
      db.prepare("INSERT INTO parent VALUES (1)"),
      db.prepare("INSERT INTO child VALUES (1, 99)"),
    ])).rejects.toThrow("FOREIGN KEY");
    expect(await db.prepare("SELECT count(*) AS count FROM parent").first("count")).toBe(0);
    const results = await db.batch([
      db.prepare("INSERT INTO parent VALUES (1) RETURNING id"),
      db.prepare("INSERT INTO child VALUES (1, 1)"),
      db.prepare("SELECT * FROM child"),
    ]);
    expect(results[0]?.results).toEqual([{ id: 1 }]);
    expect(results[1]?.meta.changes).toBe(1);
    expect(results[2]?.results).toEqual([{ id: 1, parent_id: 1 }]);
    await expect(db.batch([database().prepare("SELECT 1")])).rejects.toThrow("another database");
    await expect(db.prepare("BEGIN").run()).rejects.toThrow("Use DB.batch()");
  });

  it("executes multiple statements with comments, quoted semicolons and trigger bodies", async () => {
    const db = database();
    const result = await db.exec(`-- setup\nCREATE TABLE source (value TEXT);\nCREATE TABLE audit (value TEXT);
      CREATE TRIGGER inserted AFTER INSERT ON source BEGIN INSERT INTO audit VALUES ('semi;colon'); INSERT INTO audit VALUES (new.value); END;
      INSERT INTO source VALUES ('value;still one'); -- finished\n`);
    expect(result.count).toBe(4);
    expect(await db.prepare("SELECT value FROM audit ORDER BY rowid").raw()).toEqual([["semi;colon"], ["value;still one"]]);
  });

  it("runs actual Drizzle D1 queries, returning, dates, boolean mapping and batch results", async () => {
    const local = database();
    expect(migrateDatabase(local, directory)).toHaveLength(migrationNames.length);
    expect(migrateDatabase(local, directory)).toEqual([]);
    validateDatabase(local, directory);
    const db = drizzle(local.asD1Database(), { schema: { user } });
    const date = new Date(1_000);
    const inserted = await db.insert(user).values({ id: "drizzle", name: "Drizzle", email: "drizzle@example.invalid", emailVerified: true, createdAt: date, updatedAt: date }).returning();
    expect(inserted[0]).toMatchObject({ id: "drizzle", emailVerified: true, createdAt: date });
    const [updated, selected] = await db.batch([
      db.update(user).set({ name: "Updated" }).where(eq(user.id, "drizzle")).returning({ id: user.id, name: user.name }),
      db.select({ name: user.name }).from(user),
    ]);
    expect(updated).toEqual([{ id: "drizzle", name: "Updated" }]);
    expect(selected).toEqual([{ name: "Updated" }]);
  });
});

describe("database lifecycle and import", () => {
  it("preserves spent single-use invitations when migrating to reusable invitations", async () => {
    const previous = temporary();
    for (const name of migrationNames.filter(name => name < "0005_")) copyFileSync(join(directory, name), join(previous, name));
    const db = database();
    migrateDatabase(db, previous);
    for (const [id, redeemedAt, revokedAt] of [["open", null, null], ["spent", 123, null], ["revoked", null, 456]] as const) {
      await db.prepare(`INSERT INTO proxy_invite (id, token_hash, label, created_at, expires_at, created_by, redeemed_at, revoked_at)
        VALUES (?, ?, ?, 1, 9999999999999, 'owner', ?, ?)`).bind(id, id, id, redeemedAt, revokedAt).run();
    }
    expect(migrateDatabase(db, directory)).toEqual(["0005_invite-use-limits.sql"]);
    expect((await db.prepare("SELECT id, max_uses, use_count, redeemed_at, revoked_at FROM proxy_invite ORDER BY id").all()).results).toEqual([
      { id: "open", max_uses: 1, use_count: 0, redeemed_at: null, revoked_at: null },
      { id: "revoked", max_uses: 1, use_count: 0, redeemed_at: null, revoked_at: 456 },
      { id: "spent", max_uses: 1, use_count: 1, redeemed_at: 123, revoked_at: null },
    ]);
    expect(migrateDatabase(db, directory)).toEqual([]);
    validateDatabase(db, directory);
  });

  it("requires explicit initialization, persists writes and validates a read-only database", async () => {
    const path = join(temporary(), "db.sqlite");
    expect(() => createDatabase(path)).toThrow("does not exist");
    expect(existsSync(path)).toBe(false);
    initializeDatabase(path, directory);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const writable = createDatabase(path);
    await writable.prepare("INSERT INTO proxy_member (identity_id,created_at,updated_at) VALUES (?,1,1)").bind("ident!owner").run();
    writable.close();
    const db = createDatabase(path, { readOnly: true }); databases.push(db);
    validateDatabase(db, directory);
    expect(await db.prepare("SELECT identity_id FROM proxy_member").first("identity_id")).toBe("ident!owner");
    expect(() => initializeDatabase(path, directory)).toThrow("refusing to overwrite");
  });

  it.each([true, false])("imports D1 data with migration ledger=%s, preserves credentials, and removes only Cloudflare internals", async (ledger) => {
    const dir = temporary();
    const source = join(dir, "export.sql");
    const path = join(dir, "db.sqlite");
    const sql = exportSql(ledger);
    writeFileSync(source, sql, { mode: 0o600 });
    importDatabase(source, path, directory);
    expect(readFileSync(source, "utf8")).toBe(sql);
    const db = createDatabase(path); databases.push(db);
    validateDatabase(db, directory);
    expect(await db.prepare("SELECT credentials FROM codex_connection").first("credentials")).toBe("opaque-encrypted-codex-credentials");
    expect(await db.prepare("SELECT access_token FROM account").first("access_token")).toBe("opaque-auth-token");
    expect(await db.prepare("SELECT name FROM user").first("name")).toBe("O'Connor;\nnext line");
    expect(await db.prepare("SELECT name FROM sqlite_schema WHERE name='_cf_KV'").first()).toBeNull();
    expect(await db.prepare("SELECT count(*) AS count FROM d1_migrations").first("count")).toBe(migrationNames.length);
    if (ledger) expect(await db.prepare("SELECT applied_at FROM d1_migrations LIMIT 1").first("applied_at")).toBe("2026-09-19 00:00:00");
    expect(() => importDatabase(source, path, directory)).toThrow("refusing to overwrite");
    expect(readdirSync(dir).some((name) => name.includes(".import-"))).toBe(false);
  });

  it.each([
    ["foreign key", () => `${exportSql()}\nINSERT INTO account (id,account_id,provider_id,user_id,updated_at) VALUES ('bad','bad','hackclub','absent',1);`],
    ["syntax", () => `${exportSql()}\nTHIS IS INVALID SQL;`],
    ["schema", () => `${exportSql()}\nDROP TABLE codex_model_cache;`],
  ])("keeps a failed %s import unpublished and removes staging files", (_name, makeSql) => {
    const dir = temporary();
    const source = join(dir, "export.sql");
    const path = join(dir, "db.sqlite");
    writeFileSync(source, makeSql(), { mode: 0o600 });
    expect(() => importDatabase(source, path, directory)).toThrow();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual(["export.sql"]);
  });

  it("rolls back a failed migration and its ledger while retaining existing data", async () => {
    const db = database();
    migrateDatabase(db, directory);
    await db.prepare("INSERT INTO proxy_member (identity_id,created_at,updated_at) VALUES ('owner',1,1)").run();
    const dir = temporary();
    for (const name of readdirSync(directory).filter((name) => name.endsWith(".sql"))) copyFileSync(join(directory, name), join(dir, name));
    writeFileSync(join(dir, "9999_broken.sql"), "ALTER TABLE proxy_member ADD COLUMN scratch TEXT; DELETE FROM proxy_member; INSERT INTO absent VALUES (1);");
    expect(() => migrateDatabase(db, dir)).toThrow();
    expect(await db.prepare("SELECT identity_id FROM proxy_member").first("identity_id")).toBe("owner");
    expect(await db.prepare("SELECT count(*) AS count FROM d1_migrations").first("count")).toBe(migrationNames.length);
    expect((await db.prepare("PRAGMA table_info(proxy_member)").all<{ name: string }>()).results.some((row) => row.name === "scratch")).toBe(false);
    validateDatabase(db, directory);
  });

  it("rejects missing migration entries or schema drift before the server can listen", () => {
    const db = database();
    migrateDatabase(db, directory);
    db.sqlite.prepare("DELETE FROM d1_migrations WHERE name = ?").run(migrationNames.at(-1)!);
    expect(() => validateDatabase(db, directory)).toThrow("pending migrations");
    db.sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(migrationNames.at(-1)!);
    db.sqlite.exec("DROP INDEX usage_event_user_started; CREATE INDEX usage_event_user_started ON usage_event (started_at)");
    expect(() => validateDatabase(db, directory)).toThrow("index mismatch");
  });
});
