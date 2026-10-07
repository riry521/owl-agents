import { openDatabase } from "./connection";

function main(): void {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command !== "migrate") {
    throw new Error("Usage: owl-db migrate --database <temporary-or-configured-path> [--migrations-dir <path>]");
  }
  const databasePath = valueFor(arguments_, "--database");
  const migrationsDirectory = valueFor(arguments_, "--migrations-dir");
  const database = openDatabase(databasePath);
  try {
    const result = database.migrate(migrationsDirectory);
    const applied = database.get<{ version: string; status: string; applied_at: string }>(
      "SELECT version, status, applied_at FROM schema_migrations ORDER BY version",
    );
    console.log(
      JSON.stringify(
        {
          ...result,
          pragmas: database.pragmas(),
          appliedRow: applied ?? null,
        },
        null,
        2,
      ),
    );
  } finally {
    database.close();
  }
}

function valueFor(arguments_: readonly string[], flag: string): string {
  const index = arguments_.indexOf(flag);
  if (index === -1 || !arguments_[index + 1]) {
    throw new Error(`Missing required option ${flag}.`);
  }
  return arguments_[index + 1];
}

try {
  main();
} catch (error) {
  console.error("Database migration was not completed; startup was refused.");
  console.error(error instanceof Error ? error.message : "An unknown database error occurred.");
  process.exitCode = 1;
}
