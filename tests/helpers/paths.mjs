import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the repository root (no trailing separator). */
export const repoRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]+$/, "");

/** Absolute path of packages/db/migrations. */
export const migrationsDir = join(repoRoot, "packages/db/migrations");
