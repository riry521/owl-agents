import assert from "node:assert/strict";
import { test } from "node:test";

import { projectComment, projectIssue } from "../../packages/core/dist/auto-work/triggers/github.js";
import { label, rawComment, rawIssue, rawPullRequest, user } from "../helpers/fake-gh.mjs";

const LIMIT = 1000;

test("projectIssue reads the author from user and the label names from label objects", () => {
  const issue = projectIssue(rawIssue({ labels: [label("bug"), "plain"], user: user("hubot", "Bot") }), LIMIT);
  assert.equal(issue.number, 1347);
  assert.equal(issue.id, "1");
  assert.deepEqual(issue.user, { login: "hubot", type: "Bot" });
  assert.deepEqual(issue.labels, ["bug", "plain"]);
  assert.equal(issue.is_pull_request, false);
});

test("projectIssue marks a pull request and cuts the body to the limit", () => {
  const pr = projectIssue(rawPullRequest({ body: "x".repeat(50) }), 10);
  assert.equal(pr.is_pull_request, true);
  assert.equal(pr.body, "x".repeat(10));
});

test("projectIssue returns null when the id or a time is missing", () => {
  assert.equal(projectIssue(rawIssue({ id: undefined }), LIMIT), null);
  assert.equal(projectIssue(rawIssue({ created_at: undefined }), LIMIT), null);
  assert.equal(projectIssue(rawIssue({ updated_at: null }), LIMIT), null);
  assert.equal(projectIssue("not an object", LIMIT), null);
});

test("projectIssue keeps an Issue without a body or an author login", () => {
  const issue = projectIssue(rawIssue({ body: null, user: null }), LIMIT);
  assert.equal(issue.body, "");
  assert.deepEqual(issue.user, { login: null, type: null });
});

test("projectComment takes the Issue number from issue_url", () => {
  const comment = projectComment(rawComment(), LIMIT);
  assert.equal(comment.issue_number, 1347);
  assert.equal(comment.id, "100");
  assert.deepEqual(comment.user, { login: "octocat", type: "User" });
  assert.match(comment.body, /@owl/);
});

test("projectComment returns null when issue_url gives no number or a time is missing", () => {
  assert.equal(projectComment(rawComment({ issue_url: "https://api.github.com/repos/octocat/Hello-World/issues/" }), LIMIT), null);
  assert.equal(projectComment(rawComment({ issue_url: undefined }), LIMIT), null);
  assert.equal(projectComment(rawComment({ updated_at: undefined }), LIMIT), null);
});
