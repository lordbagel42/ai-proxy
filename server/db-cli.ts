import { parseArgs } from "node:util";
import { createDatabase, importDatabase, initializeDatabase, migrateDatabase, validateDatabase } from "./sqlite.js";

process.umask(0o077);

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      database: { type: "string" },
      migrations: { type: "string", default: "migrations" },
      sql: { type: "string" },
    },
  });
  const command = positionals[0];
  const database = values.database;
  if (positionals.length !== 1 || !database || !["init", "import", "migrate", "check"].includes(command ?? "")) {
    throw new Error("Usage: db-cli <init|import|migrate|check> --database PATH [--migrations DIR] [--sql D1_EXPORT.sql]");
  }
  if (command === "init") initializeDatabase(database, values.migrations);
  else if (command === "import") {
    if (!values.sql) throw new Error("import requires --sql D1_EXPORT.sql");
    importDatabase(values.sql, database, values.migrations);
  } else {
    const db = createDatabase(database, { readOnly: command === "check" });
    try {
      if (command === "migrate") migrateDatabase(db, values.migrations);
      validateDatabase(db, values.migrations);
    } finally { db.close(); }
  }
  console.log(JSON.stringify({ command, success: true }));
} catch (error) {
  // SQLite syntax errors can quote SQL text (including exported credentials). Keep CLI output generic.
  const detail = error instanceof Error && !String(error.message).includes("SQLITE") ? error.message : "Database operation failed";
  const safe = /^(Usage:|import requires|Destination already exists|Database |Existing database|No application migrations)/.test(detail) ? detail : "Database operation failed; source and existing destination were preserved";
  console.error(safe);
  process.exitCode = 1;
}
