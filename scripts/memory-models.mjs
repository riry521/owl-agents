#!/usr/bin/env node
// Manage the local models used by the optional memory embedder.
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const DEFAULT_MODEL = "Xenova/multilingual-e5-small";
const MODEL_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_quantized.onnx"];
const usage = `usage:
  node scripts/memory-models.mjs list [--dir <models-root>]
  node scripts/memory-models.mjs pull <org/name> [--dir <models-root>]
  node scripts/memory-models.mjs enable [--model <org/name>] [--no-pull] [--yes]`;

function parseCli() {
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: {
        dir: { type: "string" }, model: { type: "string" }, "no-pull": { type: "boolean" }, yes: { type: "boolean" }, help: { type: "boolean" },
      },
    });
    if (values.help) { console.log(usage); return null; }
    if ((values.dir !== undefined && !values.dir.trim()) || (values.model !== undefined && !values.model.trim())) throw new Error("empty option value");
    const [command, ...args] = positionals;
    if (command === "list" && args.length === 0 && values.model === undefined && values["no-pull"] === undefined && values.yes === undefined) return { command, dir: values.dir };
    if (command === "pull" && args.length === 1 && values.model === undefined && values["no-pull"] === undefined && values.yes === undefined) return { command, model: args[0], dir: values.dir };
    if (command === "enable" && args.length === 0 && values.dir === undefined) return { command, model: values.model, noPull: values["no-pull"] ?? false, yes: values.yes ?? false };
  } catch { /* show the concise usage for malformed arguments */ }
  console.error(usage);
  process.exitCode = 2;
  return null;
}

function validModel(model) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(model);
}

function defaultModelRoot(dataDir) {
  return join(dataDir ?? join(homedir(), ".owl"), "models");
}

async function optionalEmbedderConfig(dataDir) {
  if (!dataDir) return {};
  try {
    const config = JSON.parse(await readFile(join(dataDir, "memory-embedder.json"), "utf8"));
    return config && typeof config === "object" && !Array.isArray(config) ? config : {};
  } catch { return {}; }
}

async function modelRoots(dir, dataDir = process.env.OWL_DATA_DIR || undefined) {
  if (dir) return [resolve(dir)];
  const config = await optionalEmbedderConfig(dataDir);
  const roots = [
    ...(process.env.OWL_MEMORY_MODELS_DIR ? [process.env.OWL_MEMORY_MODELS_DIR] : []),
    ...(Array.isArray(config.modelsDirs) ? config.modelsDirs.filter((item) => typeof item === "string") : []),
    ...(dataDir ? [join(dataDir, "models")] : []),
    join(homedir(), ".owl", "models"),
  ];
  return [...new Set(roots.map((root) => resolve(root)))];
}

async function fileExists(path) {
  try { return (await lstat(path)).isFile(); } catch { return false; }
}

async function isUsableModel(path) {
  for (const file of MODEL_FILES) if (!(await fileExists(join(path, file)))) return false;
  return true;
}

const allocatedBytes = (stats) => Number.isFinite(stats.blocks) ? stats.blocks * 512 : stats.size;

async function directorySize(path) {
  let total = allocatedBytes(await lstat(path));
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await directorySize(child);
    else if (entry.isFile()) total += allocatedBytes(await lstat(child));
  }
  return total;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; value >= 1024 && i < units.length; i += 1) { value /= 1024; unit = units[i]; }
  return `${value.toFixed(1)} ${unit}`;
}

async function listModels(dir) {
  const roots = await modelRoots(dir);
  const found = [];
  for (const root of roots) {
    let organizations;
    try { organizations = await readdir(root, { withFileTypes: true }); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const org of organizations.filter((entry) => entry.isDirectory())) {
      const orgDir = join(root, org.name);
      for (const model of await readdir(orgDir, { withFileTypes: true })) {
        if (!model.isDirectory()) continue;
        const modelDir = join(orgDir, model.name);
        if (await isUsableModel(modelDir)) found.push({ id: `${org.name}/${model.name}`, path: modelDir, bytes: await directorySize(modelDir) });
      }
    }
  }
  console.log(`Models (${roots.join(", ")})`);
  if (!found.length) { console.log("  none found"); return; }
  for (const model of found) console.log(`  ${model.id}\t${humanSize(model.bytes)}\t${model.path}`);
}

function offlineSteps(model, destination) {
  console.error(`Offline use: on a networked machine run "node scripts/memory-models.mjs pull ${model}", then copy its "${model}" directory to "${destination}" (keep the org/name path).`);
}

async function pullModel(model, root) {
  if (!validModel(model)) throw new Error(`invalid model id: ${model} (expected org/name)`);
  const target = join(root, ...model.split("/"));
  await mkdir(target, { recursive: true });
  let saved = 0;
  let skipped = 0;
  try {
    for (const file of MODEL_FILES) {
      const destination = join(target, file);
      if (await fileExists(destination)) { skipped += 1; continue; }
      const url = `https://huggingface.co/${model}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
      const response = await fetch(url, { redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`download failed (${response.status}) for ${url}`);
      await mkdir(dirname(destination), { recursive: true });
      const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
      try {
        await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
        await rename(temporary, destination);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
      saved += 1;
      console.log(`  saved ${file}`);
    }
  } catch (error) {
    console.error(`Could not pull ${model}: ${error.message}`);
    offlineSteps(model, root);
    return false;
  }
  console.log(`${model}: ${saved} file(s) downloaded, ${skipped} existing file(s) kept; ${humanSize(await directorySize(target))} at ${target}`);
  return true;
}

async function writeEmbedderConfig(dataDir, model) {
  let current = {};
  try {
    current = JSON.parse(await readFile(join(dataDir, "memory-embedder.json"), "utf8"));
    if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("memory-embedder.json must contain a JSON object");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const next = { ...current, enabled: true, ...(model ? { model } : {}) };
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "memory-embedder.json");
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return next;
}

function dependencyStatus() {
  const workspace = dirname(dirname(fileURLToPath(import.meta.url)));
  const coreRequire = createRequire(join(workspace, "packages/core/package.json"));
  for (const name of ["@huggingface/transformers", "sqlite-vec"]) {
    try { console.log(`  ${name}: installed (${coreRequire.resolve(name)})`); }
    catch { console.log(`  ${name}: not found; run pnpm install to add optional dependencies`); }
  }
}

async function enable({ model, noPull, yes }) {
  const explicitDataDir = process.env.OWL_DATA_DIR || undefined;
  const dataDir = explicitDataDir ?? join(homedir(), ".owl");
  if (!explicitDataDir && !yes) {
    console.log(`OWL_DATA_DIR is not set. Default config location: ${join(dataDir, "memory-embedder.json")}`);
    console.log(`Default model location: ${defaultModelRoot(dataDir)}`);
    console.log("No files were written. Rerun with --yes to enable in this default location.");
    return;
  }
  if (model && !validModel(model)) throw new Error(`invalid model id: ${model} (expected org/name)`);
  const existing = await optionalEmbedderConfig(dataDir);
  const effectiveModel = model ?? existing.model ?? DEFAULT_MODEL;
  if (!validModel(effectiveModel)) throw new Error(`invalid model id: ${effectiveModel} (expected org/name)`);
  await writeEmbedderConfig(dataDir, model);
  console.log(`Enabled memory embedder in ${join(dataDir, "memory-embedder.json")}${model ? ` (model ${model})` : ""}.`);

  let pulled = true;
  if (!noPull) {
    const roots = await modelRoots(undefined, dataDir);
    let available = false;
    for (const root of roots) if (await isUsableModel(join(root, ...effectiveModel.split("/")))) { available = true; break; }
    if (available) console.log(`Model ${effectiveModel} is already available.`);
    else pulled = await pullModel(effectiveModel, defaultModelRoot(dataDir));
  } else {
    console.log(`Model pull skipped. Place ${effectiveModel} under a model root, such as ${defaultModelRoot(dataDir)}.`);
  }

  console.log("Optional embedder dependencies:");
  dependencyStatus();
  console.log("Restart the Owl server for the setting to take effect.");
  if (!pulled) process.exitCode = 1;
}

async function main() {
  const args = parseCli();
  if (!args) return;
  if (args.command === "list") { await listModels(args.dir); return; }
  if (args.command === "pull") {
    if (!validModel(args.model)) { console.error(`invalid model id: ${args.model} (expected org/name)`); process.exitCode = 2; return; }
    const root = args.dir ?? defaultModelRoot(process.env.OWL_DATA_DIR || undefined);
    if (!(await pullModel(args.model, root))) process.exitCode = 1;
    return;
  }
  await enable(args);
}

main().catch((error) => {
  console.error(`memory-models: ${error.message}`);
  process.exitCode = 1;
});
