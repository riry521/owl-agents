import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { detectNewRepositories } from "../../packages/core/dist/new-repository-detection.js";
import {
  birthtimeIsAvailable, createAutoRegistrationCore, eventTypes, gitIn, makeRepository, plannedTask, startProjectlessWork, tempFolder,
} from "../helpers/auto-registration.mjs";
import { waitFor } from "../helpers/wait.mjs";

const waitForWork = async (db, workId, state) => {
  try {
    await waitFor(
      () => (db.get("SELECT state FROM works WHERE id = ?", workId)?.state === state ? true : null),
      { timeoutMs: 20_000, intervalMs: 25, message: `Work ${workId} ${state}` },
    );
  } catch (error) {
    const snapshot = {
      work: db.get("SELECT state, project_id FROM works WHERE id = ?", workId),
      tasks: db.all("SELECT title, status FROM tasks WHERE work_id = ?", workId),
      events: db.all("SELECT type, payload_json FROM events WHERE work_id = ? ORDER BY sequence", workId)
        .map((row) => (["task.attempt_decided", "agent.crashed", "verification.completed"].includes(row.type) ? `${row.type} ${row.payload_json.slice(0, 700)}` : row.type)),
    };
    assert.fail(`${error.message}; ${JSON.stringify(snapshot)}`);
  }
};

const eventRows = (db, workId, type) =>
  db.all("SELECT sequence, payload_json FROM events WHERE work_id = ? AND type = ? ORDER BY sequence", workId, type)
    .map((row) => ({ sequence: row.sequence, ...JSON.parse(row.payload_json) }));

const AUTO_EVENTS = [
  "work.new_repositories_detected",
  "work.project_auto_registered",
  "work.project_auto_attach_requested",
  "work.project_attached",
];

test("a repository the Worker created is registered as a Project and the Work moves into it", async (t) => {
  const outside = await tempFolder(t, "owl-auto-registration-outside-");
  const repository = join(outside, "created-by-work");
  if (!await birthtimeIsAvailable(outside)) return t.skip("this file system does not report a creation time");
  let secondTaskWorktree = null;
  const { core, db, state } = await createAutoRegistrationCore(t, {
    tasks: [plannedTask("T-create", "create repository"), plannedTask("T-later", "later task", ["T-create"])],
    workers: {
      "create repository": async (request) => {
        assert.ok(request.git_template_dir, "a Project-less Work gives its Worker a template directory");
        return [await makeRepository(repository, { templateDir: request.git_template_dir })];
      },
      "later task": async (request) => {
        // Read while the worktree exists: it is removed when the Work completes.
        secondTaskWorktree = { path: request.context.worktree, gitDir: gitIn(request.context.worktree, ["rev-parse", "--git-dir"]), commonDir: gitIn(request.context.worktree, ["rev-parse", "--git-common-dir"]) };
        return [];
      },
    },
  });
  const workId = await startProjectlessWork(core, "auto-register");
  await waitForWork(db, workId, "completed");

  const project = db.get("SELECT * FROM projects");
  assert.equal(project.canonical_path, repository);
  assert.equal(project.base_branch, gitIn(repository, ["rev-parse", "--abbrev-ref", "HEAD"]));
  assert.deepEqual(JSON.parse(project.allowed_roots_json), [repository]);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM projects").count, 1);
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, project.id);

  assert.deepEqual(eventTypes(db, workId).filter((type) => AUTO_EVENTS.includes(type)), AUTO_EVENTS);
  const [detected] = eventRows(db, workId, "work.new_repositories_detected");
  assert.deepEqual(detected.candidates.map((candidate) => candidate.canonical_path), [repository]);
  const [registered] = eventRows(db, workId, "work.project_auto_registered");
  assert.equal(registered.project_id, project.id);
  assert.equal(registered.detection_event_id, db.get("SELECT id FROM events WHERE work_id = ? AND type = 'work.new_repositories_detected'", workId).id);
  const [attached] = eventRows(db, workId, "work.project_attached");
  assert.equal(attached.project_id ?? attached.to_project_id, project.id);

  // The Task after the move works in a Git worktree of the new Project, not an isolated folder.
  assert.ok(secondTaskWorktree, "the later Task ran");
  assert.notEqual(secondTaskWorktree.path, repository);
  assert.notEqual(secondTaskWorktree.gitDir, secondTaskWorktree.commonDir, "a linked Git worktree has its own git dir");
  assert.equal(realpathSync(secondTaskWorktree.commonDir), join(repository, ".git"));
  assert.equal(state.requests.find((request) => request.title === "later task").project_id, project.id);
});

test("detectNewRepositories reports every skip reason with stubbed inspection and creation time", async () => {
  const workId = "work-one";
  const startedAt = 1_000;
  const repositoryAt = (root, extra = {}) => ({ kind: "repository", root, base_branch: "main", created_by_work: workId, ...extra });
  const inspections = {
    "/new/plain": { kind: "not_repository" },
    "/new/bare": { kind: "bare" },
    "/new/linked": { kind: "linked_worktree", root: "/new/linked" },
    "/new/submodule": { kind: "submodule", root: "/new/submodule" },
    "/new/nocommit": { kind: "no_commit", root: "/new/nocommit" },
    "/new/nobranch": { kind: "no_branch", root: "/new/nobranch" },
    "/new/unmarked": repositoryAt("/new/unmarked", { created_by_work: null }),
    "/new/foreign": repositoryAt("/new/foreign", { created_by_work: "work-other" }),
    "/new/old": repositoryAt("/new/old"),
    "/new/nobirth": repositoryAt("/new/nobirth"),
    "/new/good-a": repositoryAt("/new/good-a"),
    "/new/good-b": repositoryAt("/new/good-b"),
    "/registered/inner": repositoryAt("/registered/inner"),
    "/via-link": repositoryAt("/owl/data/real-repo"),
  };
  const births = { "/new/old": 500, "/new/nobirth": 0, "/new/good-a": 2_000, "/new/good-b": 3_000 };
  const files = Object.keys(inspections).map((path) => ({ file: `${path}/file.txt` }));
  files.push({ file: "/owl/data/outputs/x.txt" }, { file: "/registered/project/a.txt" }, { file: "relative/path.txt" });
  const run = (overrides = {}) => detectNewRepositories({
    inspect: async (path) => inspections[path] ?? { kind: "not_repository" },
    birthtimeMs: async (path) => births[path] ?? Number.NaN,
  }, {
    workId,
    reports: [{ changes: files }],
    workStartedAtMs: () => startedAt,
    excludedRoots: ["/owl"],
    registeredProjectPaths: ["/registered/project", "/registered/inner"],
    ...overrides,
  });

  const result = await run();
  const reasons = Object.fromEntries(result.skipped.map((entry) => [entry.path, entry.reason]));
  assert.deepEqual(result.repositories.map((candidate) => candidate.canonical_path).sort(), ["/new/good-a", "/new/good-b"]);
  assert.deepEqual(result.repositories.map((candidate) => candidate.base_branch), ["main", "main"]);
  assert.equal(reasons["/owl/data/outputs/x.txt"], "owl_managed_path");
  assert.equal(reasons["/registered/project/a.txt"], "inside_registered_project");
  assert.equal(reasons["/owl/data/real-repo"], "owl_managed_path", "a link into an Owl-managed path is judged by the real path");
  assert.equal(reasons["/new/plain"], "not_repository");
  assert.equal(reasons["/new/bare"], "bare");
  assert.equal(reasons["/new/linked"], "linked_worktree");
  assert.equal(reasons["/new/submodule"], "submodule");
  assert.equal(reasons["/new/nocommit"], "no_commit");
  assert.equal(reasons["/new/nobranch"], "no_branch");
  assert.equal(reasons["/new/unmarked"], "not_created_by_work");
  assert.equal(reasons["/new/foreign"], "not_created_by_work");
  assert.equal(reasons["/new/old"], "existed_before_work");
  assert.equal(reasons["/new/nobirth"], "birthtime_unavailable");
  assert.equal(Object.values(reasons).includes(undefined), false);
  assert.equal(Object.keys(reasons).some((path) => path.startsWith("relative")), false, "relative paths are ignored");

  const unknownStart = await run({ workStartedAtMs: () => null });
  assert.deepEqual(unknownStart.repositories, []);
  assert.equal(unknownStart.skipped.filter((entry) => entry.reason === "birthtime_unavailable").length, 4);

  const throwing = await detectNewRepositories({
    inspect: async (path) => inspections[path],
    birthtimeMs: async () => { throw new Error("stat failed"); },
  }, { workId, reports: [{ changes: [{ file: "/new/good-a/file.txt" }] }], workStartedAtMs: () => startedAt, excludedRoots: [], registeredProjectPaths: [] });
  assert.deepEqual(throwing.repositories, []);
  assert.equal(throwing.skipped[0].reason, "birthtime_unavailable");
});

test("pre-existing folders, unmarked repositories and another Work's repositories are not registered", async (t) => {
  const outside = await tempFolder(t, "owl-auto-registration-skip-");
  if (!await birthtimeIsAvailable(outside)) return t.skip("this file system does not report a creation time");
  const plain = join(outside, "plain-before");
  const existingRepository = join(outside, "repository-before");
  await mkdir(plain);
  await makeRepository(existingRepository);
  // Wait until both folders are strictly older than the Work's start.
  await waitFor(() => (Date.now() > Math.max(...[plain, existingRepository].map(() => Date.now() - 1)) ? true : null), { timeoutMs: 1_000, intervalMs: 5, message: "clock advance" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const unmarked = join(outside, "unmarked");
  const foreign = join(outside, "foreign");
  const { core, db } = await createAutoRegistrationCore(t, {
    tasks: [plannedTask("T-one", "make repositories")],
    workers: {
      "make repositories": async (request) => {
        // Files outside every qualifying repository fail Core's claimed-change check unless reported as removed, so these are.
        const notOutput = (file) => ({ file, action: "removed" });
        const files = [];
        files.push(notOutput(await makeRepository(unmarked)));
        // A mark that names a different Work.
        const foreignTemplate = join(outside, "foreign-template");
        await mkdir(foreignTemplate, { recursive: true });
        gitIn(outside, ["config", "--file", join(foreignTemplate, "config"), "owl.createdByWork", "another-work"]);
        files.push(notOutput(await makeRepository(foreign, { templateDir: foreignTemplate })));
        // Marked init in an older plain folder and in an older repository.
        gitIn(plain, ["init", "--initial-branch=main"], { GIT_TEMPLATE_DIR: request.git_template_dir });
        gitIn(plain, ["-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "--allow-empty", "-m", "x"]);
        gitIn(existingRepository, ["init"], { GIT_TEMPLATE_DIR: request.git_template_dir });
        for (const file of [join(plain, "a.txt"), join(existingRepository, "created.txt")]) {
          await writeFile(file, "x");
          files.push(notOutput(file));
        }
        return files;
      },
    },
  });
  const workId = await startProjectlessWork(core, "auto-register-skip");
  await waitForWork(db, workId, "completed");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM projects").count, 0);
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
  assert.deepEqual(eventTypes(db, workId).filter((type) => AUTO_EVENTS.includes(type)), []);
});

test("several candidates are all registered but the Work is attached to none", async (t) => {
  const outside = await tempFolder(t, "owl-auto-registration-multi-");
  if (!await birthtimeIsAvailable(outside)) return t.skip("this file system does not report a creation time");
  const first = join(outside, "first");
  const second = join(outside, "second");
  const { core, db } = await createAutoRegistrationCore(t, {
    tasks: [plannedTask("T-one", "make two")],
    workers: {
      "make two": async (request) => [
        await makeRepository(first, { templateDir: request.git_template_dir }),
        await makeRepository(second, { templateDir: request.git_template_dir }),
      ],
    },
  });
  const workId = await startProjectlessWork(core, "auto-register-multi");
  await waitForWork(db, workId, "completed");
  assert.deepEqual(db.all("SELECT canonical_path FROM projects ORDER BY canonical_path").map((row) => row.canonical_path), [first, second]);
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
  const types = eventTypes(db, workId);
  assert.equal(types.filter((type) => type === "work.project_auto_registered").length, 2);
  assert.equal(types.includes("work.project_auto_attach_requested"), false);
  assert.equal(types.includes("work.project_attached"), false);
  const [skipped] = eventRows(db, workId, "work.project_auto_attach_skipped");
  assert.equal(skipped.reason, "multiple_repositories");
});

test("a registration failure leaves the Work without a Project and records a skip", async (t) => {
  const outside = await tempFolder(t, "owl-auto-registration-fail-");
  if (!await birthtimeIsAvailable(outside)) return t.skip("this file system does not report a creation time");
  const repository = join(outside, "created");
  const { core, db } = await createAutoRegistrationCore(t, {
    tasks: [plannedTask("T-one", "make one")],
    workers: { "make one": async (request) => [await makeRepository(repository, { templateDir: request.git_template_dir })] },
  });
  core.createProject = async () => { throw new Error("registration refused"); };
  const workId = await startProjectlessWork(core, "auto-register-fail");
  await waitForWork(db, workId, "completed");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM projects").count, 0);
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
  assert.equal(eventTypes(db, workId).includes("work.project_attached"), false);
  assert.equal(eventRows(db, workId, "work.project_auto_attach_skipped").length, 1);
});

test("a registration failure of a later Task cancels the attach an earlier Task requested", async (t) => {
  const outside = await tempFolder(t, "owl-auto-registration-late-fail-");
  if (!await birthtimeIsAvailable(outside)) return t.skip("this file system does not report a creation time");
  const good = join(outside, "good");
  const bad = join(outside, "bad");
  const { core, db } = await createAutoRegistrationCore(t, {
    tasks: [plannedTask("T-good", "make good"), plannedTask("T-bad", "make bad")],
    workers: {
      "make good": async (request) => [await makeRepository(good, { templateDir: request.git_template_dir })],
      "make bad": async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return [await makeRepository(bad, { templateDir: request.git_template_dir })];
      },
    },
  });
  const original = core.createProject.bind(core);
  core.createProject = async (request) => {
    if (request.payload.canonical_path === bad) throw new Error("registration refused");
    return original(request);
  };
  const workId = await startProjectlessWork(core, "auto-register-late-fail");
  await waitForWork(db, workId, "completed");
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);
  assert.equal(eventTypes(db, workId).includes("work.project_attached"), false);
  const reasons = eventRows(db, workId, "work.project_auto_attach_skipped").map((row) => row.reason);
  assert.deepEqual(reasons, ["registration_failed", "registration_failed"]);
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

/** Blocks core.createProject until `release()`; `entered` resolves when the first call arrives. */
function holdRegistration(core) {
  const entered = deferred();
  const gate = deferred();
  const original = core.createProject.bind(core);
  core.createProject = async (request) => {
    entered.resolve();
    await gate.promise;
    return original(request);
  };
  return { entered: entered.promise, release: gate.resolve };
}

test("a Task that was preparing its worktree when detection began does not start until the Work is attached", async (t) => {
  const outside = await tempFolder(t, "owl-auto-registration-hold-");
  if (!await birthtimeIsAvailable(outside)) return t.skip("this file system does not report a creation time");
  const repository = join(outside, "created");
  const preparing = deferred();
  const releasePreparation = deferred();
  let otherWorktree = null;
  const { core, db, root, state } = await createAutoRegistrationCore(t, {
    tasks: [plannedTask("T-create", "create repository"), plannedTask("T-other", "other task")],
    coreOptions: { max_parallel: 2, dispatcher: { tick_interval_ms: 25, global_max_parallel: 2 } },
    workers: {
      "create repository": async (request) => [await makeRepository(repository, { templateDir: request.git_template_dir })],
      "other task": async (request) => {
        otherWorktree = { path: request.context.worktree, gitDir: gitIn(request.context.worktree, ["rev-parse", "--git-dir"]), commonDir: gitIn(request.context.worktree, ["rev-parse", "--git-common-dir"]) };
        return [];
      },
    },
  });
  const gateway = core.gitGateway();
  const prepare = gateway.prepareWorktree.bind(gateway);
  let isolatedMarker = null;
  gateway.prepareWorktree = async (request) => {
    const prepared = await prepare(request);
    if (db.get("SELECT title FROM tasks WHERE id = ?", request.task_id)?.title !== "other task" || isolatedMarker) return prepared;
    // Reached only after the creating Task has been launched: its pipeline settles while this preparation is paused.
    isolatedMarker = join(prepared.worktree_path, "isolated-output.txt");
    await writeFile(isolatedMarker, "left in the isolated folder");
    preparing.resolve();
    await releasePreparation.promise;
    return prepared;
  };
  const registration = holdRegistration(core);
  const workId = await startProjectlessWork(core, "auto-register-hold");
  await preparing.promise;
  await registration.entered;
  assert.equal(db.get("SELECT status FROM tasks WHERE title = 'create repository'").status, "completed");

  releasePreparation.resolve();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const other = db.get("SELECT id, status FROM tasks WHERE title = 'other task'");
  assert.equal(other.status, "ready", "the held Task stays ready");
  assert.equal(db.all("SELECT 1 FROM events WHERE work_id = ? AND task_id = ? AND type = 'task.started'", workId, other.id).length, 0);
  assert.equal(db.all("SELECT 1 FROM agent_runs WHERE task_id = ?", other.id).length, 0);
  assert.equal(state.requests.some((request) => request.title === "other task"), false);

  registration.release();
  await waitForWork(db, workId, "completed");
  assert.ok(otherWorktree, "the held Task started after the attach");
  assert.notEqual(otherWorktree.gitDir, otherWorktree.commonDir, "it runs in a Git worktree of the Project");
  assert.equal(realpathSync(otherWorktree.commonDir), join(repository, ".git"));
  assert.equal(await readFile(join(root, "data", "outputs", workId, "isolated-output.txt"), "utf8"), "left in the isolated folder");
  const attachedAt = db.get("SELECT sequence FROM events WHERE work_id = ? AND type = 'work.project_attached'", workId).sequence;
  const startedAt = db.get("SELECT sequence FROM events WHERE work_id = ? AND task_id = ? AND type = 'task.started'", workId, other.id).sequence;
  assert.ok(attachedAt < startedAt, "the Task starts after work.project_attached");
});

test("a fix-pending Task keeps its isolated folder while other launches wait, and the attach waits for it", async (t) => {
  const outside = await tempFolder(t, "owl-auto-registration-fix-");
  if (!await birthtimeIsAvailable(outside)) return t.skip("this file system does not report a creation time");
  const repository = join(outside, "created");
  const fixGate = deferred();
  const fixAttemptStarted = deferred();
  const worktrees = { fix: [], after: null };
  let fixAttempts = 0;
  const { core, db, state } = await createAutoRegistrationCore(t, {
    tasks: [
      plannedTask("T-create", "create repository"),
      plannedTask("T-fix", "fix me", [], "code"),
      plannedTask("T-after", "after task", ["T-create"]),
    ],
    coreOptions: { max_parallel: 3, dispatcher: { tick_interval_ms: 25, global_max_parallel: 3 } },
    workers: {
      "create repository": async (request) => {
        // Let the fix-pending Task fail verification once before the repository appears.
        await waitFor(() => (fixAttempts >= 1 ? true : null), { timeoutMs: 10_000, intervalMs: 10, message: "first fix attempt" });
        return [await makeRepository(repository, { templateDir: request.git_template_dir })];
      },
      "fix me": async (request) => {
        fixAttempts += 1;
        worktrees.fix.push(request.context.worktree);
        if (fixAttempts === 1) return [];
        fixAttemptStarted.resolve();
        await fixGate.promise;
        await writeFile(join(request.context.worktree, "out.mjs"), "export {};\n");
        return [{ file: "out.mjs", action: "created" }];
      },
      "after task": async (request) => {
        worktrees.after = { path: request.context.worktree, gitDir: gitIn(request.context.worktree, ["rev-parse", "--git-dir"]), commonDir: gitIn(request.context.worktree, ["rev-parse", "--git-common-dir"]) };
        return [];
      },
    },
  });
  const workId = await startProjectlessWork(core, "auto-register-fix");
  await fixAttemptStarted.promise;
  await waitFor(() => (eventTypes(db, workId).includes("work.project_auto_attach_requested") ? true : null), { timeoutMs: 10_000, intervalMs: 25, message: "attach requested" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(eventTypes(db, workId).includes("work.project_attached"), false, "the attach waits for the fix-pending Task");
  assert.equal(state.requests.some((request) => request.title === "after task"), false, "a normal Task does not launch during the hold");
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, null);

  fixGate.resolve();
  await waitForWork(db, workId, "completed");
  assert.equal(worktrees.fix.length, 2);
  assert.equal(worktrees.fix[1], worktrees.fix[0], "the fix-pending Task continues in its original isolated folder");
  const fixCompleted = db.get("SELECT MAX(sequence) AS sequence FROM events WHERE work_id = ? AND type = 'agent.exited' AND task_id = (SELECT id FROM tasks WHERE title = 'fix me')", workId).sequence;
  const attached = db.get("SELECT sequence FROM events WHERE work_id = ? AND type = 'work.project_attached'", workId).sequence;
  assert.ok(fixCompleted < attached);
  assert.notEqual(worktrees.after.gitDir, worktrees.after.commonDir, "the held Task runs in a Git worktree of the Project");
});

test("when the last Task creates the repository the attach comes before the Final Manager and Work completion", async (t) => {
  const outside = await tempFolder(t, "owl-auto-registration-last-");
  if (!await birthtimeIsAvailable(outside)) return t.skip("this file system does not report a creation time");
  const repository = join(outside, "created");
  const { core, db, state } = await createAutoRegistrationCore(t, {
    tasks: [plannedTask("T-only", "only task")],
    workers: { "only task": async (request) => [await makeRepository(repository, { templateDir: request.git_template_dir })] },
  });
  const registration = holdRegistration(core);
  const workId = await startProjectlessWork(core, "auto-register-last");
  await registration.entered;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(state.finalizeCalls.length, 0, "the Final Manager waits for the detection");
  assert.notEqual(db.get("SELECT state FROM works WHERE id = ?", workId).state, "completed");
  registration.release();
  await waitForWork(db, workId, "completed");

  const project = db.get("SELECT id FROM projects");
  assert.equal(db.get("SELECT project_id FROM works WHERE id = ?", workId).project_id, project.id);
  const attached = db.get("SELECT sequence FROM events WHERE work_id = ? AND type = 'work.project_attached'", workId).sequence;
  const completed = db.get("SELECT sequence FROM events WHERE work_id = ? AND type = 'work.completed'", workId).sequence;
  assert.ok(attached < completed);
  assert.deepEqual(state.finalizeCalls, [{ attached: true }], "the Final Manager runs once, after the attach");
});

test("with no candidates, or when the attach is skipped, completion resumes", async (t) => {
  const none = await createAutoRegistrationCore(t, {
    tasks: [plannedTask("T-only", "only task")],
    workers: { "only task": async () => [] },
  });
  const noneWork = await startProjectlessWork(none.core, "auto-register-none");
  await waitForWork(none.db, noneWork, "completed");
  assert.deepEqual(none.state.finalizeCalls, [{ attached: false }]);
  assert.deepEqual(eventTypes(none.db, noneWork).filter((type) => AUTO_EVENTS.includes(type)), []);

  const outside = await tempFolder(t, "owl-auto-registration-skipped-");
  if (!await birthtimeIsAvailable(outside)) return;
  const first = join(outside, "first");
  const second = join(outside, "second");
  const two = await createAutoRegistrationCore(t, {
    tasks: [plannedTask("T-only", "only task")],
    workers: {
      "only task": async (request) => [
        await makeRepository(first, { templateDir: request.git_template_dir }),
        await makeRepository(second, { templateDir: request.git_template_dir }),
      ],
    },
  });
  const twoWork = await startProjectlessWork(two.core, "auto-register-two");
  await waitForWork(two.db, twoWork, "completed");
  assert.deepEqual(two.state.finalizeCalls, [{ attached: false }]);
});
