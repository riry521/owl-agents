// Usage: node scripts/create-project-overviews.mjs [knowledge-dir] [--api=<base>] [--dry-run] [--purpose-file <path>] [--rebuild] [--investigate] [--project=<id>] [--investigator=<module>]
// --rebuild regenerates, under the same filename, only each project's own existing project-overview-<id>.md (frontmatter project_ids contains the id); it never creates files or touches other notes. With --dry-run it only lists the targets.
// --investigate regenerates, under the same filename, only each project's own existing project-overview-<id>.md with a read-only investigation agent (manual_investigation); --project=<id> narrows the targets to one project. With --dry-run it only lists the targets and writes nothing. When no investigator is available or it fails for a project, the rule-based note is written and "rule-based (...)" is printed.
// 本番では先に `node scripts/create-project-overviews.mjs <vault> --api=http://localhost:3787/api/v1 --project=<id> --investigate --dry-run` で対象を確認し、Owner 確認後に `curl -X POST http://localhost:3787/api/v1/projects/<id>/overview/investigate -H 'content-type: application/json' --data '{}'` を実行する。複数プロジェクトは --project=<id> ごとにdry-runし、同じIDをPOSTする。
// --investigator=<module> is an ES module whose default export is the investigation function (request) => {ok,investigation}|{ok:false,error}; without it, runProjectInvestigation of createAgentRunner (packages/agent-runtime/dist) is used if it exists.
// Creates one overview note per registered project; a project already listed in any note's frontmatter project_ids is skipped.
// --purpose-file (JSON {project_id: purpose}; keep it outside the repo) sets the purpose and also overwrites that project's own project-overview-<id>.md, only if its frontmatter project_ids contains the project id.
// The storage dir defaults to GET /settings/knowledge-storage (design §6.1); it must already exist. Projects come from the API only.
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { KnowledgeBase } from "../packages/core/dist/knowledge-base.js";
import { KnowledgeNotes } from "../packages/core/dist/knowledge-notes.js";
import { GitProjectSourceReader, ProjectOverviewService, projectOverviewFilename } from "../packages/core/dist/project-overview-note.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const api = args.find((a) => a.startsWith("--api="))?.slice(6) ?? "http://localhost:3787/api/v1";
const onlyProject = args.find((a) => a.startsWith("--project="))?.slice(10);
const investigatorPath = args.find((a) => a.startsWith("--investigator="))?.slice(15);
const investigate = flag("--investigate");
const pfIndex = args.indexOf("--purpose-file");
const purposeFile = pfIndex >= 0 ? args[pfIndex + 1] : undefined;
const [explicitDir] = args.filter((a, i) => !a.startsWith("--") && (pfIndex < 0 || i !== pfIndex + 1));
const fail = (message) => { console.error(message); process.exit(1); };

const getJson = async (path) => {
  const res = await fetch(`${api}${path}`);
  if (!res.ok) fail(`GET ${path} failed: ${res.status}`);
  return (await res.json()).data;
};
let dir = explicitDir;
if (!dir) {
  const storage = await getJson("/settings/knowledge-storage");
  if (storage.state !== "available") fail(`knowledge storage is ${storage.state}`);
  dir = storage.path;
}
const isDir = await stat(dir).then((s) => s.isDirectory(), () => false);
if (!isDir) fail(`knowledge dir does not exist: ${dir}`);

const notesDir = join(dir, "notes");
const existing = new Set(await readdir(notesDir).catch(() => []));
const projects = await getJson("/projects");
const purposes = purposeFile ? JSON.parse(await readFile(purposeFile, "utf8")) : {};
const parser = new KnowledgeNotes(new KnowledgeBase("/nonexistent", { rootDir: () => dir }));
const covered = new Set();
const ownIds = new Map();
for (const file of existing) {
  if (!file.endsWith(".md")) continue;
  try { const ids = parser.parse(await readFile(join(notesDir, file), "utf8")).project_ids; ownIds.set(file, ids); for (const id of ids) covered.add(id); } catch { /* unparsable note: the filename check still applies */ }
}
if (onlyProject && !projects.some((p) => p.id === onlyProject)) fail(`unknown project: ${onlyProject}`);
const plan = projects.filter((p) => !onlyProject || p.id === onlyProject).map((p) => {
  const file = projectOverviewFilename(p.id);
  const own = ownIds.get(file)?.includes(p.id) ?? false;
  const update = (typeof purposes[p.id] === "string" || flag("--rebuild") || investigate) && own;
  return { p, file, update, exists: !update && (existing.has(file) || covered.has(p.id)) };
});
const todo = plan.filter((item) => !item.exists && (item.update || !(flag("--rebuild") || investigate)));
console.log(`knowledge dir: ${dir}`);
console.log(`existing notes: ${[...existing].filter((f) => f.endsWith(".md")).length}`);
for (const item of plan) console.log(`${item.update ? "update " : item.exists || flag("--rebuild") || investigate ? "skip   " : "create "} ${item.file} ${item.p.name}`);
if (flag("--dry-run")) { console.log("dry-run: nothing written"); process.exit(0); }

const byId = new Map(projects.map((p) => [p.id, { ...p, verification_plan_json: JSON.stringify(p.verification_plan ?? []) }]));
let investigator;
if (investigate && !flag("--dry-run")) {
  try {
    if (investigatorPath) investigator = (await import(pathToFileURL(resolve(investigatorPath)).href)).default;
    else {
      const { createAgentRunner } = await import("../packages/agent-runtime/dist/index.js");
      const runner = createAgentRunner({});
      if (typeof runner.runProjectInvestigation === "function") investigator = (request) => runner.runProjectInvestigation(request);
    }
  } catch (error) { console.log(`investigation unavailable: ${error?.message ?? error}`); }
  if (typeof investigator !== "function") { investigator = undefined; console.log("rule-based: no investigation agent available"); }
}
const failed = new Map();
const accepted = new Set();
const service = new ProjectOverviewService({
  notes: new KnowledgeNotes(new KnowledgeBase("/nonexistent", { rootDir: () => dir })),
  withWrite: (fn) => fn(),
  getProject: (id) => byId.get(id) ?? null,
  reader: new GitProjectSourceReader(),
  purposeOf: (id) => purposes[id],
  onInvestigated: (id, valid) => { if (valid) accepted.add(id); else failed.set(id, "invalid or insufficient result"); },
  investigate: investigator && (async (input) => {
    let result;
    try {
      result = await investigator({ project: { id: input.project.id, name: input.project.name, base_branch: input.project.base_branch, commit: input.commit }, repo_path: input.project.canonical_path, known_facts: input.known_facts, recent_works: [], timeout_ms: 600000 });
    } catch (error) { result = { ok: false, error: String(error?.message ?? error) }; }
    if (!result?.ok) failed.set(input.project.id, result?.error ?? "failed");
    return result;
  }),
});
for (const { p, update } of todo) {
  const manual = investigate && update;
  const outcome = await service.refresh(p.id, { kind: manual ? "manual_investigation" : "project_created" });
  const note = manual ? (failed.has(p.id) || (investigator && !accepted.has(p.id)) ? ` rule-based (investigation failed or result rejected: ${failed.get(p.id) ?? "invalid or insufficient result"})` : investigator ? "" : " rule-based (investigation unavailable)") : "";
  console.log(p.id, p.name, outcome + note);
}
