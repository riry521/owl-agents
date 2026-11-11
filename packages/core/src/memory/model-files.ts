import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { embeddingsEnabledSetting } from "./embedder.js";

/** The files transformers.js reads for dtype q8 (embedder-child's dtype). A constant, not a setting: it follows the dtype. */
export const MODEL_FILES: readonly string[] = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];

/** `org/name` only; a segment holding `..` could write outside the models directory. */
export function isValidModelName(model: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(model) && !model.includes("..");
}

export const modelDirFor = (modelsDir: string, model: string): string => join(modelsDir, model);

export const hasModelFiles = (dir: string): boolean => MODEL_FILES.every((file) => existsSync(join(dir, file)));

/** The first `<modelsDir>/<model>` that holds every model file. A partial download is not a model. */
export function findModelDir(modelsDirs: readonly string[], model: string): string | null {
  return modelsDirs.map((dir) => modelDirFor(dir, model)).find(hasModelFiles) ?? null;
}

export interface DownloadModelResult { readonly dir: string; readonly downloaded: string[]; readonly skipped: string[]; readonly bytes: number }

/**
 * Fetches the model files from `<host>/<model>/resolve/main/<file>`. Only `owl embeddings` and scripts call this; search never does.
 * Each file goes to a temp name first, so a failed download leaves no file under its final name.
 */
export async function downloadModel(input: {
  model: string; modelsDir: string; host: string; fetch?: typeof fetch; onProgress?: (file: string, bytes: number) => void;
}): Promise<DownloadModelResult> {
  if (!isValidModelName(input.model)) throw new Error(`invalid model name: ${input.model}`);
  const doFetch = input.fetch ?? fetch;
  const dir = modelDirFor(input.modelsDir, input.model);
  const downloaded: string[] = [];
  const skipped: string[] = [];
  let bytes = 0;
  for (const file of MODEL_FILES) {
    const target = join(dir, file);
    if (existsSync(target)) { skipped.push(file); continue; }
    const url = `${input.host.replace(/\/+$/u, "")}/${input.model}/resolve/main/${file}`;
    const temp = `${target}.part`;
    try {
      const response = await doFetch(url, { redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(temp, data);
      renameSync(temp, target);
      bytes += data.length;
      downloaded.push(file);
      input.onProgress?.(file, data.length);
    } catch (error) {
      rmSync(temp, { force: true });
      throw new Error(`failed to download ${file} from ${url}: ${(error as Error).message}`);
    }
  }
  return { dir, downloaded, skipped, bytes };
}

/** Writes `enabled: true` to memory-embedder.json only when neither the environment nor the file decides it. A malformed file is never overwritten. */
export async function enableIfUnset(dataDir: string, env: NodeJS.ProcessEnv = process.env): Promise<"written" | "already_enabled" | "disabled"> {
  const path = join(dataDir, "memory-embedder.json");
  let file: Record<string, unknown> = {};
  if (existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch (error) {
      throw new Error(`${path} is not valid JSON; fix it by hand: ${(error as Error).message}`);
    }
  }
  const decided = embeddingsEnabledSetting(env, file.enabled);
  if (decided !== undefined) return decided ? "already_enabled" : "disabled";
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...file, enabled: true }, null, 2)}\n`);
  return "written";
}
