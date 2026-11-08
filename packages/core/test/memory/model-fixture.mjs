import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MODEL_FILES } from "../../dist/memory/model-files.js";

/** Puts every file of a model into `dir`, so findModelDir treats it as complete. */
export function writeModelFiles(dir) {
  for (const file of MODEL_FILES) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), "{}");
  }
}
