import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { Core, NoopGitGateway } from "../../packages/core/dist/index.js";
import { FakeClock } from "../helpers/clock.mjs";
import { createTestCore } from "../helpers/core.mjs";
import { createFakeGh, label, rawComment, rawIssue, rawPullRequest, user } from "../helpers/fake-gh.mjs";

const T0 = new Date(Date.UTC(2026, 5, 1, 10, 0, 0));
const minutes = (n) => new Date(T0.getTime() + n * 60_000);
const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/u, "Z");
const REPO = "octocat/Hello-World";

const worth = () => ({
  ok: true,
  judgment: { worth_fixing: true, reason: "直す価値がある", duplicate_of_work_id: null, duplicate_reason: null, work: { title: "GitHub の Issue", summary: "原因を調べて直す", size: "normal" } },
});

/** A Core with automatic Work creation on, a fake clock, a fake gh and a judgment stub that records its requests. */
async function setup(t, { github = {}, ...coreOptions } = {}) {
  const calls = [];
  const gh = createFakeGh({ repo: REPO });
  const clock = new FakeClock(T0);
  const { root, db, core } = await createTestCore(t, {
    git: new NoopGitGateway(),
    version: "auto-work-github",
    agentRunner: { runAutoWorkJudgment: async (request) => { calls.push(request); return worth(); } },
    autoWork: { clock, gh },
    ...coreOptions,
  }, { prefix: "owl-auto-work-github-" });
  const directory = join(root, "rules", "auto-work");
  await mkdir(join(directory, "projects"), { recursive: true });
  await writeFile(join(directory, "defaults.json"), await readFile(new URL("../../rules/auto-work/defaults.json", import.meta.url), "utf8"));
  await writeFile(join(directory, "projects", "proj1.json"), JSON.stringify({ github: { repo: REPO, poll_minutes: 1440, ...github } }));
  const now = T0.toISOString();
  await db.createWriteLane().transact((tx) => {
    tx.run("INSERT OR IGNORE INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'owner:default', ?, ?)", now, now);
    tx.run(
      `INSERT INTO projects (id, owner_id, name, canonical_path, base_branch, allowed_roots_json,
         verification_plan_json, worktree_prepare_argv_json, created_at, updated_at)
       VALUES ('proj1', 'owner:default', 'Project 1', ?, 'main', '[]', '[]', '[]', ?, ?)`,
      join(root, "proj1"), now, now,
    );
    tx.run(
      `INSERT INTO settings (key, owner_id, schema_version, value_json, updated_at) VALUES ('auto_work', 'owner:default', '1.0.0', ?, ?)`,
      JSON.stringify({ schema_version: "1.0.0", version: 1, enabled: true, projects: { proj1: { enabled: true } } }), now,
    );
  });
  await core.start();
  const poll = () => core.autoWork.runAutoWorkNow("github", "proj1");
  const events = () => db.all("SELECT * FROM auto_work_events ORDER BY created_at, id");
  const works = () => db.all("SELECT * FROM works ORDER BY created_at, id");
  return { db, core, clock, gh, calls, poll, events, works };
}

/** An Issue created at `minute` after T0, by `login` unless said otherwise. */
const issue = (minute, overrides = {}) => rawIssue({ created_at: iso(minutes(minute)), updated_at: iso(minutes(minute)), ...overrides });

test("an Issue from an allowed author becomes a draft Work and is told about it on GitHub", async (t) => {
  const { clock, gh, calls, poll, events, works } = await setup(t, { github: { owl_url: "http://owl.example" } });
  gh.state.issues.push(issue(5, { number: 7, id: 71, title: "ログインできない", body: "押しても反応しない" }));
  await clock.advanceTo(minutes(10));
  await poll();

  const [work] = works();
  assert.equal(work.state, "memo");
  const [event] = events();
  assert.equal(event.verdict, "created");
  assert.equal(event.action, "draft");
  assert.equal(event.github_repo, REPO);
  assert.equal(event.github_issue_number, 7);
  assert.equal(event.work_id, work.id);
  assert.equal(calls.length, 1);

  assert.equal(gh.state.posted.length, 1);
  const comment = gh.state.calls.find((call) => call.args[0] === "issue");
  assert.deepEqual(comment.args.slice(0, 2), ["issue", "comment"]);
  assert.ok(comment.args.includes("--body-file"));
  assert.equal(comment.stdin, gh.state.posted[0].body);
  assert.match(gh.state.posted[0].body, /下書き/u);
  assert.equal(gh.state.posted[0].number, 7);
  assert.match(event.github_comment_url, /^https:\/\/github\.com\/octocat\/Hello-World\/issues\/7#issuecomment-/u);
});

test("@me is the login that gh api user returns", async (t) => {
  const { clock, gh, poll, events } = await setup(t);
  gh.state.login = "hubot-owner";
  gh.state.issues.push(issue(5, { number: 1, id: 1, user: user("octocat") }));
  gh.state.issues.push(issue(6, { number: 2, id: 2, user: user("hubot-owner") }));
  await clock.advanceTo(minutes(10));
  await poll();
  const byNumber = Object.fromEntries(events().map((event) => [event.github_issue_number, event.verdict]));
  assert.equal(byNumber[1], "unauthorized");
  assert.equal(byNumber[2], "created");
  assert.ok(gh.state.calls.some((call) => call.args.join(" ") === "api user"));
});

test("authors who are not allowed, Bots and Issues without the required label are unauthorized and the judge is not called", async (t) => {
  const { clock, gh, calls, poll, events, works } = await setup(t, { github: { allowed_users: ["octocat", "hubot"], require_labels: ["owl"] } });
  gh.state.issues.push(issue(1, { number: 1, id: 1, user: user("stranger"), labels: [label("owl")], title: "秘密の題名", body: "秘密の本文" }));
  gh.state.issues.push(issue(2, { number: 2, id: 2, user: user("hubot", "Bot"), labels: [label("owl")], title: "bot の題名", body: "bot の本文" }));
  gh.state.issues.push(issue(3, { number: 3, id: 3, user: user("octocat"), labels: [label("bug")], title: "ラベル違い", body: "ラベル違いの本文" }));
  await clock.advanceTo(minutes(10));
  await poll();

  const list = events();
  const refused = list.filter((event) => event.github_issue_number !== null);
  assert.equal(refused.length, 3);
  for (const event of refused) {
    assert.equal(event.verdict, "unauthorized");
    assert.equal(event.title, "");
    assert.equal(event.detail, "");
  }
  assert.equal(calls.length, 0);
  assert.equal(works().length, 0);
  assert.equal(gh.state.posted.length, 0);
});

test("a comment with the mention on an Issue becomes a signal; one without it does not", async (t) => {
  const { clock, gh, poll, events } = await setup(t);
  gh.state.issues.push(issue(-3000, { number: 9, id: 9 }));
  gh.state.comments.push(rawComment({ id: 501, issue_url: `https://api.github.com/repos/${REPO}/issues/9`, body: "@owl これも直して", created_at: iso(minutes(5)), updated_at: iso(minutes(5)) }));
  gh.state.comments.push(rawComment({ id: 502, issue_url: `https://api.github.com/repos/${REPO}/issues/9`, body: "ただの雑談", created_at: iso(minutes(6)), updated_at: iso(minutes(6)) }));
  await clock.advanceTo(minutes(10));
  await poll();
  const list = events();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, "issue_comment");
  assert.equal(list[0].github_comment_id, "501");
  assert.equal(list[0].verdict, "created");
});

test("a comment on a pull request is a pr_comment, and one on a pull request is ignored when pr_comments is not watched", async (t) => {
  const watching = await setup(t);
  watching.gh.state.issues.push(rawPullRequest({ number: 12, id: 12, created_at: iso(minutes(-3000)), updated_at: iso(minutes(-3000)) }));
  watching.gh.state.comments.push(rawComment({ id: 601, issue_url: `https://api.github.com/repos/${REPO}/issues/12`, body: "@owl レビューして", created_at: iso(minutes(5)), updated_at: iso(minutes(5)) }));
  await watching.clock.advanceTo(minutes(10));
  await watching.poll();
  assert.equal(watching.events()[0].kind, "pr_comment");
  assert.equal(watching.events()[0].github_is_pull_request, 1);

  const muted = await setup(t, { github: { watch: ["issues", "issue_comments"] } });
  muted.gh.state.issues.push(rawPullRequest({ number: 12, id: 12, created_at: iso(minutes(-3000)), updated_at: iso(minutes(-3000)) }));
  muted.gh.state.comments.push(rawComment({ id: 601, issue_url: `https://api.github.com/repos/${REPO}/issues/12`, body: "@owl レビューして", created_at: iso(minutes(5)), updated_at: iso(minutes(5)) }));
  await muted.clock.advanceTo(minutes(10));
  await muted.poll();
  assert.equal(muted.events().length, 0);
});

test("a finished Work is reported with the pull request found by branch name, and the URL is kept", async (t) => {
  const { clock, gh, core, poll, events } = await setup(t);
  gh.state.issues.push(issue(5, { number: 7, id: 71 }));
  await clock.advanceTo(minutes(10));
  await poll();
  const [created] = events();
  const prUrl = `https://github.com/${REPO}/pull/21`;
  gh.state.prs.push({ number: 21, url: prUrl, head: `owl/work/${created.work_id}/work` });

  await core.autoWork.onWorkFinished(created.work_id, "completed");

  const list = gh.state.calls.find((call) => call.args[0] === "pr" && call.args[1] === "list");
  assert.ok(list, "gh pr list was called");
  assert.equal(list.args[list.args.indexOf("--head") + 1], `owl/work/${created.work_id}/work`);
  const finished = gh.state.posted.at(-1);
  assert.equal(finished.number, 7);
  assert.ok(finished.body.includes(prUrl));
  const [event] = events();
  assert.equal(event.github_pr_url, prUrl);
  assert.notEqual(event.finished_notified_at, null);

  const before = gh.state.posted.length;
  await core.autoWork.onWorkFinished(created.work_id, "completed");
  assert.equal(gh.state.posted.length, before, "a Work is reported once");
});

test("a finished Work without a pull request is reported with its branch", async (t) => {
  const { clock, gh, core, poll, events } = await setup(t);
  gh.state.issues.push(issue(5, { number: 7, id: 71 }));
  await clock.advanceTo(minutes(10));
  await poll();
  const [created] = events();
  await core.autoWork.onWorkFinished(created.work_id, "completed");
  assert.ok(gh.state.posted.at(-1).body.includes(`owl/work/${created.work_id}/work`));
  assert.equal(events()[0].github_pr_url, null);
});

test("a report that fails is retried: finished_notified_at stays empty", async (t) => {
  const { clock, gh, core, poll, events } = await setup(t);
  gh.state.issues.push(issue(5, { number: 7, id: 71 }));
  await clock.advanceTo(minutes(10));
  await poll();
  const [created] = events();
  gh.state.fail.pr_list = 1;
  await assert.rejects(core.autoWork.onWorkFinished(created.work_id, "completed"));
  assert.equal(events()[0].finished_notified_at, null);
  await core.autoWork.onWorkFinished(created.work_id, "completed");
  assert.notEqual(events()[0].finished_notified_at, null);
});

test("fetching again with an earlier since does not make the same item twice, and since is the previous since minus the margin", async (t) => {
  const { clock, gh, calls, poll, events, works } = await setup(t);
  gh.state.issues.push(issue(5, { number: 7, id: 71 }));
  await clock.advanceTo(minutes(10));
  await poll();
  await clock.advanceTo(minutes(20));
  await poll();

  assert.equal(events().length, 1);
  assert.equal(works().length, 1);
  assert.equal(calls.length, 1);
  const [first, second] = gh.sinceOf("issues");
  assert.equal(first, iso(new Date(minutes(10).getTime() - 24 * 3_600_000 - 120_000)), "the first poll looks back initial_lookback_hours");
  // The second poll starts where the first one began (minute 10) minus since_margin_seconds.
  assert.equal(second, iso(new Date(minutes(10).getTime() - 120_000)));
  assert.equal(gh.state.issues.length, 1);
});

test("an Issue that changes after it was handled is not made into a second Work", async (t) => {
  const { clock, gh, poll, events, works } = await setup(t);
  gh.state.issues.push(issue(5, { number: 7, id: 71 }));
  await clock.advanceTo(minutes(10));
  await poll();
  gh.state.issues[0] = { ...gh.state.issues[0], updated_at: iso(minutes(12)), body: "追記" };
  await clock.advanceTo(minutes(20));
  await poll();
  assert.equal(works().length, 1);
  assert.equal(events().length, 1);
});

test("truncated output does not advance since and the next poll continues from the same since", async (t) => {
  const { clock, gh, poll, events, db } = await setup(t);
  gh.state.issues.push(issue(5, { number: 7, id: 71 }));
  gh.state.truncate.issues = 1;
  await clock.advanceTo(minutes(10));
  await poll();

  assert.equal(events().length, 0, "nothing is taken from a cut response");
  const cursor = db.get("SELECT since, last_error FROM auto_work_github_cursors WHERE project_id = 'proj1' AND list = 'issues'");
  assert.equal(cursor.last_error, "output_truncated");
  const sinceAfterFailure = cursor.since;
  assert.equal(sinceAfterFailure, iso(new Date(minutes(10).getTime() - 24 * 3_600_000)));

  await clock.advanceTo(minutes(20));
  await poll();
  const [first, second] = gh.sinceOf("issues");
  assert.equal(second, first, "the same window is read again");
  assert.equal(events().length, 1);
  const after = db.get("SELECT since, last_error FROM auto_work_github_cursors WHERE project_id = 'proj1' AND list = 'issues'");
  assert.equal(after.last_error, null);
  assert.equal(after.since, iso(minutes(20)));
});

test("a failing gh does not advance since either, and the other list is still read", async (t) => {
  const { clock, gh, poll, events, db } = await setup(t);
  gh.state.issues.push(issue(-3000, { number: 9, id: 9 }));
  gh.state.comments.push(rawComment({ id: 701, body: "ただの雑談", issue_url: `https://api.github.com/repos/${REPO}/issues/9`, created_at: iso(minutes(5)), updated_at: iso(minutes(5)) }));
  gh.state.fail.issues = 1;
  await clock.advanceTo(minutes(10));
  await poll();
  const issues = db.get("SELECT since, last_error FROM auto_work_github_cursors WHERE project_id = 'proj1' AND list = 'issues'");
  const comments = db.get("SELECT since, last_error FROM auto_work_github_cursors WHERE project_id = 'proj1' AND list = 'comments'");
  assert.notEqual(issues.last_error, null);
  assert.equal(issues.since, iso(new Date(minutes(10).getTime() - 24 * 3_600_000)));
  assert.equal(comments.last_error, null);
  assert.equal(comments.since, iso(minutes(10)));
  assert.equal(events().length, 0, "the comment has no mention");
});

test("pages are read until one is shorter than per_page", async (t) => {
  const { clock, gh, poll, events } = await setup(t, { github: { per_page: 2 } });
  for (const number of [1, 2, 3]) gh.state.issues.push(issue(number, { number, id: number }));
  await clock.advanceTo(minutes(10));
  await poll();
  const pages = gh.state.calls.filter((call) => call.args[1]?.startsWith(`repos/${REPO}/issues?`)).map((call) => new URLSearchParams(call.args[1].split("?")[1]).get("page"));
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(events().length, 3);
});

test("an unreadable response stops the list and nothing is recorded", async (t) => {
  const { clock, gh, poll, events, db } = await setup(t);
  gh.state.issues.push(issue(5, { number: 7, id: 71 }), { number: 8, title: "id がない", created_at: iso(minutes(5)), updated_at: iso(minutes(5)) });
  await clock.advanceTo(minutes(10));
  await poll();
  assert.equal(events().length, 0);
  const cursor = db.get("SELECT last_error FROM auto_work_github_cursors WHERE project_id = 'proj1' AND list = 'issues'");
  assert.equal(cursor.last_error, "unexpected_response");
});

test("running now without a repository says so", async (t) => {
  const { core } = await setup(t, { github: { repo: null } });
  await assert.rejects(core.autoWork.runAutoWorkNow("github", "proj1"), /repository/u);
});

test("the periodic poll runs every poll_minutes of the clock", async (t) => {
  const { clock, gh, events } = await setup(t, { github: { poll_minutes: 5 } });
  gh.state.issues.push(issue(1, { number: 7, id: 71 }));
  await clock.advanceTo(minutes(6));
  for (let i = 0; i < 200 && events().length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(events().length, 1);
});

const cursorOf = (db, list) => db.get("SELECT since, last_error FROM auto_work_github_cursors WHERE project_id = 'proj1' AND list = ?", list);
const githubAlerts = (db) => db.all("SELECT id FROM events WHERE type = 'system.alert' AND payload_json LIKE '%auto_work_github_failed%'");
const commentsOn = (number, count) => Array.from({ length: count }, (_, i) => rawComment({
  id: 800 + i, issue_url: `https://api.github.com/repos/${REPO}/issues/${number}`, body: `@owl ${i}`,
  created_at: iso(minutes(5 + i)), updated_at: iso(minutes(5 + i)),
}));

test("a pull request in the Issue list is an issue_opened signal when it meets the same conditions as an Issue", async (t) => {
  const { clock, gh, poll, events } = await setup(t, { github: { allowed_users: ["octocat"], require_labels: ["owl"] } });
  const when = { created_at: iso(minutes(5)), updated_at: iso(minutes(5)) };
  gh.state.issues.push(rawPullRequest({ number: 31, id: 31, ...when, labels: [label("owl")] }));
  gh.state.issues.push(rawPullRequest({ number: 32, id: 32, ...when, labels: [label("bug")] }));
  gh.state.issues.push(rawPullRequest({ number: 33, id: 33, ...when, labels: [label("owl")], user: user("stranger") }));
  gh.state.issues.push(rawPullRequest({ number: 34, id: 34, created_at: iso(minutes(-3000)), updated_at: iso(minutes(5)), labels: [] }));
  await clock.advanceTo(minutes(10));
  await poll();
  const byNumber = Object.fromEntries(events().map((event) => [event.github_issue_number, event]));
  assert.equal(byNumber[31].kind, "issue_opened");
  assert.equal(byNumber[31].verdict, "created");
  assert.equal(byNumber[31].github_is_pull_request, 1);
  assert.equal(byNumber[32].verdict, "unauthorized");
  assert.equal(byNumber[33].verdict, "unauthorized");
  assert.equal(byNumber[34], undefined, "an old pull request without the label is no signal");
});

test("comments are read over several pages and a second fetch does not make the same comment twice", async (t) => {
  const { clock, gh, calls, poll, events } = await setup(t, { github: { per_page: 2 } });
  gh.state.issues.push(issue(-3000, { number: 9, id: 9 }));
  gh.state.comments.push(...commentsOn(9, 3));
  await clock.advanceTo(minutes(10));
  await poll();
  const pages = gh.state.calls.filter((call) => call.args[1]?.startsWith(`repos/${REPO}/issues/comments?`)).map((call) => new URLSearchParams(call.args[1].split("?")[1]).get("page"));
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(events().length, 3);
  const judged = calls.length;
  await clock.advanceTo(minutes(20));
  await poll();
  assert.equal(events().length, 3);
  assert.equal(calls.length, judged, "the judge saw no comment twice");
});

test("a cut second page keeps the first page, records nothing of the cut page, alerts, and the next poll continues without duplicates", async (t) => {
  const { clock, gh, poll, events, db } = await setup(t, { github: { per_page: 2 } });
  for (const number of [1, 2, 3]) gh.state.issues.push(issue(number, { number, id: number }));
  gh.state.truncate.issues = 1;
  gh.state.truncatePage.issues = 2;
  await clock.advanceTo(minutes(10));
  await poll();

  assert.deepEqual(events().map((event) => event.github_issue_number).sort(), [1, 2]);
  assert.equal(db.all("SELECT * FROM auto_work_github_items WHERE item_type = 'issue'").length, 2, "the cut page is not in the ledger");
  const stopped = cursorOf(db, "issues");
  assert.equal(stopped.last_error, "output_truncated");
  assert.equal(stopped.since, iso(new Date(minutes(10).getTime() - 24 * 3_600_000)));
  for (let i = 0; i < 100 && githubAlerts(db).length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(githubAlerts(db).length, 1);

  await clock.advanceTo(minutes(20));
  await poll();
  assert.deepEqual(events().map((event) => event.github_issue_number).sort(), [1, 2, 3]);
  assert.equal(cursorOf(db, "issues").since, iso(minutes(20)));
});

test("an Issue refused for a missing label is judged again once the label is added, and the same update is not recorded twice", async (t) => {
  const { clock, gh, poll, events, works } = await setup(t, { github: { require_labels: ["owl"] } });
  gh.state.issues.push(issue(5, { number: 7, id: 71 }));
  await clock.advanceTo(minutes(10));
  await poll();
  assert.deepEqual(events().map((event) => event.verdict), ["unauthorized"]);

  await clock.advanceTo(minutes(15));
  await poll();
  assert.equal(events().length, 1, "the same update came back and the unauthorized row did not pile up");

  gh.state.issues[0] = { ...gh.state.issues[0], labels: [label("owl")], updated_at: iso(minutes(16)) };
  await clock.advanceTo(minutes(20));
  await poll();
  assert.deepEqual(events().map((event) => event.verdict), ["unauthorized", "created"]);
  assert.equal(works().length, 1);
});

test("a comment id fetched again is not a signal the second time", async (t) => {
  const { clock, gh, poll, events } = await setup(t);
  gh.state.issues.push(issue(-3000, { number: 9, id: 9 }));
  gh.state.comments.push(...commentsOn(9, 1));
  await clock.advanceTo(minutes(10));
  await poll();
  assert.equal(events().length, 1);
  gh.state.comments[0] = { ...gh.state.comments[0], updated_at: iso(minutes(12)), body: "@owl 直したあとの本文" };
  await clock.advanceTo(minutes(20));
  await poll();
  assert.equal(events().length, 1);
});
