import { randomUUID } from "node:crypto";
import { open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isSeq, parseDocument, type Document } from "yaml";
import { isPidAlive } from "@owl/shared";

const CONFIG_FILE_NAME = "serena_config.yml";
const PROJECT_FILE = join(".serena", "project.yml");
const LOCK_RETRY_MS = 25;
const LOCK_WAIT_MS = 15_000;
/** Age after which an ownerless lock or a reclaim guard counts as abandoned. */
const LOCK_STALE_MS = 30_000;

/** Where Serena keeps its config: the agent environment's SERENA_HOME (empty or unset means `<home>/.serena`). */
export function serenaConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.SERENA_HOME || join(home, ".serena"), CONFIG_FILE_NAME);
}

function entryText(item: unknown): string {
  return String((item as { value?: unknown }).value ?? item);
}

/** Registered project roots, as Serena stores them: a list of absolute path strings under `projects`. */
export function readRegisteredProjects(doc: Document): string[] {
  const projects = doc.get("projects");
  return isSeq(projects) ? projects.items.map(entryText) : [];
}

/** Adds `projectRoot` to `projects` when absent. Returns whether the document changed. */
export function addRegisteredProject(doc: Document, projectRoot: string): boolean {
  if (readRegisteredProjects(doc).includes(projectRoot)) return false;
  const projects = doc.get("projects");
  if (isSeq(projects)) projects.add(projectRoot);
  else doc.set("projects", doc.createNode([projectRoot]));
  return true;
}

/** Removes every entry in `roots` from `projects`. Returns whether the document changed. */
export function removeRegisteredProjects(doc: Document, roots: readonly string[]): boolean {
  const projects = doc.get("projects");
  if (!isSeq(projects)) return false;
  const before = projects.items.length;
  projects.items = projects.items.filter((item) => !roots.includes(entryText(item)));
  return projects.items.length !== before;
}

const processLanes = new Map<string, Promise<unknown>>();

const exists = (path: string) => stat(path).then(() => true, () => false);

const readOwner = (lockPath: string) => readFile(lockPath, "utf8").then((text) => text, () => null);

/** Runs `operation` while holding `lockPath`; the file holds `<pid>:<token>` of its owner. */
async function withLockFile<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(owner);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (await reclaimDeadLock(lockPath)) continue;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lockPath}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_RETRY_MS));
    }
  }
  try {
    return await operation();
  } finally {
    if ((await readOwner(lockPath)) === owner) await rm(lockPath, { force: true });
  }
}

/**
 * Removes a lock whose owner process is gone. Reclaiming is serialized by a second
 * lock file and re-checks the owner inside it, so a lock another process took after
 * the dead one was removed is never deleted. A live owner's lock is never removed
 * on age alone; only a lock with no readable owner is removed once it is old.
 */
async function reclaimDeadLock(lockPath: string): Promise<boolean> {
  const seen = await readOwner(lockPath);
  if (seen === null) return true;
  const pid = Number(seen.split(":")[0]);
  const dead = Number.isInteger(pid) && pid > 0
    ? !isPidAlive(pid, { epermAlive: true })
    : await stat(lockPath).then((info) => Date.now() - info.mtimeMs > LOCK_STALE_MS, () => false);
  if (!dead) return false;
  const guard = `${lockPath}.reclaim`;
  try {
    await (await open(guard, "wx")).close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = await stat(guard).then((info) => Date.now() - info.mtimeMs, () => 0);
    if (age > LOCK_STALE_MS) await rm(guard, { force: true });
    return false;
  }
  try {
    if ((await readOwner(lockPath)) === seen) await rm(lockPath, { force: true });
  } finally {
    await rm(guard, { force: true });
  }
  return true;
}

/**
 * Edits the Serena config under a lock (this process's queue, then a lock file
 * for other processes). The edit is written to a temp file in the same folder
 * and renamed over the config, so a reader never sees a half-written file.
 * A missing config is left alone: Owl never creates it.
 */
export async function editSerenaConfig(configPath: string, edit: (doc: Document) => boolean | Promise<boolean>): Promise<boolean> {
  if (!(await exists(configPath))) return false;
  const previous = processLanes.get(configPath) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => withLockFile(`${configPath}.lock`, async () => {
    let text: string;
    try {
      text = await readFile(configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const doc = parseDocument(text);
    if (doc.errors.length > 0 || !(await edit(doc))) return false;
    const temp = join(dirname(configPath), `.${CONFIG_FILE_NAME}.${randomUUID()}.tmp`);
    try {
      await writeFile(temp, doc.toString({ indentSeq: false }), { mode: (await stat(configPath)).mode & 0o777 });
      await rename(temp, configPath);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
    return true;
  }));
  processLanes.set(configPath, run);
  try {
    return await run;
  } finally {
    if (processLanes.get(configPath) === run) processLanes.delete(configPath);
  }
}

/** True only when the path is absent; any other stat error (EACCES, EIO...) is thrown so a registration is never dropped on a guess. */
async function isAbsent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw error;
  }
}

async function missingProjects(doc: Document): Promise<string[]> {
  const missing: string[] = [];
  for (const path of readRegisteredProjects(doc)) if (await isAbsent(path)) missing.push(path);
  return missing;
}

/**
 * Lists registered project paths that no longer exist and, with `apply`, removes just those.
 * Without `apply` the config is only read. Other entries, keys and their order stay as they are.
 * With `apply` the paths are checked again inside the write lock, so a registration made
 * meanwhile is kept; a path that cannot be inspected aborts the run.
 */
export async function pruneMissingSerenaProjects(configPath: string, apply: boolean): Promise<string[]> {
  if (!apply) {
    const text = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    return text === null ? [] : missingProjects(parseDocument(text));
  }
  let removed: string[] = [];
  await editSerenaConfig(configPath, async (doc) => {
    removed = await missingProjects(doc);
    return removed.length > 0 && removeRegisteredProjects(doc, removed);
  });
  return removed;
}

/** Registers a worktree that has `.serena/project.yml`, so Serena finds it registered and does not write the config itself. */
export async function registerSerenaProject(configPath: string, worktree: string): Promise<boolean> {
  const root = await realpath(worktree).catch(() => null);
  if (root === null || !(await exists(join(root, PROJECT_FILE)))) return false;
  return editSerenaConfig(configPath, (doc) => addRegisteredProject(doc, root));
}

/** Removes a worktree's registration; other entries and keys stay as they are. */
export async function unregisterSerenaProject(configPath: string, worktree: string): Promise<boolean> {
  const real = await realpath(worktree).catch(() => null);
  if (!(await exists(join(real ?? worktree, PROJECT_FILE)))) return false;
  return editSerenaConfig(configPath, (doc) => removeRegisteredProjects(doc, real === null ? [worktree] : [worktree, real]));
}
