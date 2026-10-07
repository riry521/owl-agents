import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { advisorFolderDefaults, isGitIgnoredDirectory, normalizeAdvisorFolder } from "../../apps/server/dist/advisor-folders.js";
import { AppSettingsStore } from "../../apps/server/dist/app-settings-store.js";
import { MemoryCore } from "../../apps/server/dist/core.js";
import { errorBody } from "../../apps/server/dist/errors.js";
import { listHostDirectories } from "../../apps/server/dist/fs-directories.js";
import { createUlid } from "../../packages/db/dist/index.js";
import { command, createTestCore } from "../helpers/core.mjs";
import { git } from "../helpers/git.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const ownerId = "owner:default";
const runner = { runManagerPlan: async () => ({}), runWorker: async () => ({}), runReviewer: async () => ({}), runAdvisor: async () => ({ reply: "ok" }) };
let sequence = 0;
function envelope(payload) { return command(payload, `advisor-folders-${++sequence}`); }

test("folder values expand home, reject relative paths, and reset to defaults", async (t) => {
  const root = await tempDir(t, "owl-folders-normalize-");
  assert.equal(normalizeAdvisorFolder("~/Pictures"), join(homedir(), "Pictures"));
  assert.throws(() => normalizeAdvisorFolder("relative/path"), /absolute/);
  assert.throws(() => normalizeAdvisorFolder("x".repeat(1025)), /absolute/);
  assert.throws(() => normalizeAdvisorFolder("/tmp/\0bad"), /absolute/);
  assert.equal(normalizeAdvisorFolder(""), "");
  const core = new MemoryCore({ version: "test", owlRoot: root, dataDir: root });
  const defaults = advisorFolderDefaults(root);
  assert.deepEqual((await core.getAdvisorFolders()).custom, { shared_dir: false, screenshot_dir: false });
  await core.setAdvisorFolders(join(root, "outside"), join(root, "screenshots"));
  assert.equal((await core.getAdvisorFolders()).custom.shared_dir, true);
  await core.setAdvisorFolders("", "");
  assert.equal((await core.getAdvisorFolders()).shared_dir, defaults.sharedDir);
});

test("folder validation messages follow the Owner language", () => {
  const error = { code: "validation_error", details: {}, message: "フォルダは絶対パスで指定してください。" };
  assert.equal(errorBody("test", error, "en").error.message, "Specify the folder as an absolute path.");
  assert.equal(errorBody("test", error, "ja").error.message, error.message);
  for (const [japanese, english, code] of [
    ["フォルダが見つかりません。", "The folder was not found.", "not_found"],
    ["フォルダではありません。", "This is not a folder.", "validation_error"],
    ["このフォルダを開く権限がありません。", "You do not have permission to open this folder.", "forbidden"],
  ]) {
    assert.equal(errorBody("test", { code, details: {}, message: japanese }, "en").error.message, english);
  }
});

test("directory listing filters, sorts, validates, and preserves symbolic link paths", async (t) => {
  const root = await tempDir(t, "owl-fs-list-");
  for (const name of ["folder10", "folder2", ".secret"]) await mkdir(join(root, name));
  await writeFile(join(root, "file.txt"), "file");
  await symlink(join(root, "folder2"), join(root, "link"));
  await symlink(join(root, "file.txt"), join(root, "file-link"));
  const listed = await listHostDirectories(root, false, root);
  assert.equal(listed.path, root);
  assert.equal(listed.parent, dirname(root));
  assert.deepEqual(listed.entries, ["folder2", "folder10", "link"].map((name) => ({ name, path: join(root, name) })));
  assert.equal(listed.truncated, false);
  assert.deepEqual((await listHostDirectories(root, true, root)).entries.map((entry) => entry.name), [".secret", "folder2", "folder10", "link"]);
  assert.ok(listed.shortcuts.some((shortcut) => shortcut.key === "owl_data" && shortcut.path === root));
  assert.equal((await listHostDirectories("/", false, root)).parent, null);
  assert.equal((await listHostDirectories(undefined, false, root)).path, homedir());
  await assert.rejects(() => listHostDirectories("relative", false, root), { status: 422, code: "validation_error" });
  await assert.rejects(() => listHostDirectories("/tmp/\0bad", false, root), { status: 422, code: "validation_error" });
  await assert.rejects(() => listHostDirectories("x".repeat(1025), false, root), { status: 422, code: "validation_error" });
  await assert.rejects(() => listHostDirectories(join(root, "missing"), false, root), { status: 404, code: "not_found" });
  await assert.rejects(() => listHostDirectories(join(root, "file.txt"), false, root), { status: 422, code: "validation_error" });
});

test("folder settings persist and an empty value remains a default marker", async (t) => {
  const root = await tempDir(t, "owl-folders-store-");
  const data = join(root, "data");
  const settings = new AppSettingsStore(root, data);
  assert.equal(settings.getAdvisorSharedDir(), "");
  assert.equal(settings.getAdvisorScreenshotDir(), "");
  settings.setAdvisorSharedDir(join(root, "shared"));
  settings.setAdvisorScreenshotDir(join(root, "screenshots"));
  const reloaded = new AppSettingsStore(root, data);
  assert.equal(reloaded.getAdvisorSharedDir(), join(root, "shared"));
  assert.equal(reloaded.getAdvisorScreenshotDir(), join(root, "screenshots"));
  reloaded.setAdvisorFolders("", "");
  assert.equal(new AppSettingsStore(root, data).getAdvisorSharedDir(), "");
});

test("git ignored shared locations and paths outside repositories are accepted", async (t) => {
  const root = await tempDir(t, "owl-folders-git-");
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  await writeFile(join(repo, ".gitignore"), "ignored/\n");
  assert.equal(isGitIgnoredDirectory(join(repo, "ignored", "shared")), true);
  assert.equal(isGitIgnoredDirectory(join(repo, "tracked")), false);
  assert.equal(isGitIgnoredDirectory(join(root, "outside")), true);
});

test("Advisor folder API returns defaults, saves values, and rejects tracked paths", async (t) => {
  const root = await tempDir(t, "owl-folders-api-");
  git(root, "init", "-q");
  await writeFile(join(root, ".gitignore"), "shared/\ncustom/\n");
  const core = new MemoryCore({ version: "test", owlRoot: root, dataDir: root });
  const api = await startTestHttpServer(t, { core, webOut: root, owlRoot: root });
  if (!api) return t.skip("localhost listen is not permitted");
  const base = `${api.baseUrl}/api/v1/settings/advisor-folders`;
  const get = async () => (await (await fetch(base)).json()).data;
  const put = async (payload) => fetch(base, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope(payload)) });
  const initial = await get();
  assert.equal(initial.shared_dir, join(root, "shared"));
  assert.deepEqual(initial.custom, { shared_dir: false, screenshot_dir: false });
  const saved = await put({ shared_dir: join(root, "custom"), screenshot_dir: join(root, "screenshots") });
  assert.equal(saved.status, 200);
  assert.deepEqual((await get()).custom, { shared_dir: true, screenshot_dir: true });
  const invalid = await put({ shared_dir: join(root, "tracked"), screenshot_dir: "" });
  assert.equal(invalid.status, 422);
});

test("directory picker lists sorted folders, hidden folders, and path errors", async (t) => {
  const root = await tempDir(t, "owl-fs-directories-");
  for (const name of ["folder10", "folder2", ".secret"]) await mkdir(join(root, name));
  await writeFile(join(root, "file.txt"), "file");
  await symlink(join(root, "folder2"), join(root, "linked-folder"));
  await symlink(join(root, "file.txt"), join(root, "linked-file"));
  const core = new MemoryCore({ version: "test", owlRoot: root, dataDir: root });
  const api = await startTestHttpServer(t, { core, webOut: root, owlRoot: root, dataDir: root });
  if (!api) return t.skip("localhost listen is not permitted");
  const base = `${api.baseUrl}/api/v1/fs/directories`;
  const get = async (path, showHidden) => {
    const url = new URL(base);
    if (path !== undefined) url.searchParams.set("path", path);
    if (showHidden !== undefined) url.searchParams.set("show_hidden", showHidden);
    const response = await fetch(url);
    return { status: response.status, body: await response.json() };
  };
  const listed = await get(root);
  assert.equal(listed.status, 200);
  assert.deepEqual(Object.keys(listed.body), ["request_id", "data", "version"]);
  assert.equal(listed.body.version, 0);
  assert.deepEqual({ ...listed.body.data, shortcuts: undefined }, {
    path: root, parent: dirname(root), entries: ["folder2", "folder10", "linked-folder"].map((name) => ({ name, path: join(root, name) })),
    truncated: false, shortcuts: undefined,
  });
  assert.ok(listed.body.data.shortcuts.some((shortcut) => shortcut.key === "home" && shortcut.path === homedir()));
  assert.ok(listed.body.data.shortcuts.some((shortcut) => shortcut.key === "owl_data" && shortcut.path === root));
  const hidden = await get(root, "1");
  assert.deepEqual(hidden.body.data.entries.map((entry) => entry.name), [".secret", "folder2", "folder10", "linked-folder"]);
  const relative = await get("relative/path");
  assert.equal(relative.status, 422);
  assert.equal(relative.body.error.code, "validation_error");
  const missing = await get(join(root, "missing"));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, "not_found");
  const file = await get(join(root, "file.txt"));
  assert.equal(file.status, 422);
  assert.equal(file.body.error.code, "validation_error");
  assert.equal((await get()).body.data.path, homedir());
  assert.equal((await get("/")).body.data.parent, null);
});

test("Advisor prompt contains both configured folders", async (t) => {
  const { root, core } = await createTestCore(t, {
    agentRunner: runner,
    getAdvisorFolders: () => ({ sharedDir: join(root, "shared"), screenshotDir: join(root, "screenshots") }),
  }, { prefix: "owl-folders-prompt-" });
  const prompt = core.getAdvisorSettingsSnapshot().systemPrompt;
  assert.match(prompt, /## Owner folders/u);
  assert.ok(prompt.includes(join(root, "shared")));
  assert.ok(prompt.includes(join(root, "screenshots")));
});

test("uploads copy with collision names, resolve to shared paths, and quarantine executables", async (t) => {
  const { root, db, core } = await createTestCore(t, { agentRunner: runner, getAdvisorSharedDir: () => join(root, "shared") }, { prefix: "owl-folders-upload-" });
  const shared = join(root, "shared");
  const account = createUlid();
  await core.ensureConnectorAccount(ownerId, "slack", account);
  async function upload(id, filename, mime) {
    const content = Buffer.from(id);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const ticket = (await core.registerInboundUpload(ownerId, envelope({ provider: "slack", account_id: account, external_attachment_id: id,
      filename, declared_mime: mime, declared_bytes: content.length, sha256: null, work_id: null, conversation_id: null,
      conversation_hint: { work_id: null, dm_ref: "folders", thread_ref: null } }))).data;
    await core.putInboundUpload(ownerId, ticket.upload_id, { content, sha256, mime });
    const done = (await core.completeInboundUpload(ownerId, ticket.upload_id, envelope({ bytes: content.length, sha256, mime }))).data;
    return { ticket, done, content };
  }
  const first = await upload("one", "report.txt", "text/plain");
  const second = await upload("two", "report.txt", "text/plain");
  const executable = await upload("three", "run.sh", "text/x-shellscript");
  assert.deepEqual(await readFile(join(shared, "report.txt")), first.content);
  assert.deepEqual(await readFile(join(shared, "report (2).txt")), second.content);
  assert.equal(executable.done.status, "quarantined");
  assert.equal(db.get("SELECT shared_copy_path FROM inbound_uploads WHERE id = ?", executable.ticket.upload_id).shared_copy_path, null);
  const messageId = createUlid();
  await db.createWriteLane().transact((tx) => tx.run(
    "INSERT INTO messages (id, conversation_id, provider, account_id, source_message_id, body, attachment_ids_json, received_at, created_at) VALUES (?, ?, 'slack', ?, ?, '', ?, ?, ?)",
    messageId, first.ticket.conversation_id, account, "folder-path-test", JSON.stringify([first.ticket.upload_id]), new Date().toISOString(), new Date().toISOString(),
  ));
  assert.deepEqual(core.resolveAttachmentPaths(messageId).paths, [join(shared, "report.txt")]);
  await rm(join(shared, "report.txt"));
  assert.deepEqual(core.resolveAttachmentPaths(messageId).paths, [join(root, db.get("SELECT path FROM artifacts WHERE id = ?", first.done.artifact_id).path)]);
});
