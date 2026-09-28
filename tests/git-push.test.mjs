import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NoopGitGateway,
  basePushArgs,
  classifyPushFailure,
  parsePushPorcelain,
  redactCredentials,
  safeRemoteName,
} from "../packages/core/dist/index.js";

test("base push arguments target one branch without force or bypass flags", () => {
  const args = basePushArgs("origin", "main", "refs/heads/main");
  assert.deepEqual(args, ["push", "--porcelain", "origin", "refs/heads/main:refs/heads/main"]);
  assert.equal(args.some((arg) => ["--force", "-f", "--force-with-lease", "--mirror", "--no-verify"].includes(arg) || arg.startsWith("+")), false);
});

test("base push arguments reject unsafe names and refs", () => {
  for (const name of ["", "-x", "two words", "line\nbreak"]) assert.equal(safeRemoteName(name), false);
  for (const name of ["-x", "", "two words"]) assert.throws(() => basePushArgs(name, "main", "refs/heads/main"));
  assert.throws(() => basePushArgs("origin", "", "refs/heads/main"));
  assert.throws(() => basePushArgs("origin", "main", "refs/tags/main"));
});

test("push porcelain parses update, create, up-to-date, and rejected ref lines", () => {
  assert.deepEqual(parsePushPorcelain([
    "To /tmp/remote.git",
    " \trefs/heads/main:refs/heads/main\tupdate",
    "*\trefs/heads/new:refs/heads/new\t[new branch]",
    "=\trefs/heads/stable:refs/heads/stable\t[up to date]",
    "!\trefs/heads/old:refs/heads/old\t[rejected] (non-fast-forward)",
    "Done",
  ].join("\n")).map(({ flag, from, to }) => ({ flag, from, to })), [
    { flag: " ", from: "refs/heads/main", to: "refs/heads/main" },
    { flag: "*", from: "refs/heads/new", to: "refs/heads/new" },
    { flag: "=", from: "refs/heads/stable", to: "refs/heads/stable" },
    { flag: "!", from: "refs/heads/old", to: "refs/heads/old" },
  ]);
});

test("push failure classification follows hook, ref, auth, and network precedence", () => {
  const classify = (stdout, stderr, timedOut = false) => classifyPushFailure({ stdout, stderr, timedOut, exitCode: 1 });
  assert.deepEqual(classify("", "", true), { failure: "network", hook_side: null });
  assert.deepEqual(classify("", "owl-pre-push: blocked: policy"), { failure: "hook_rejected", hook_side: "local" });
  assert.deepEqual(classify("!\trefs/heads/main:refs/heads/main\t[remote rejected] policy", ""), { failure: "hook_rejected", hook_side: "remote" });
  assert.deepEqual(classify("!\trefs/heads/main:refs/heads/main\t[rejected] (non-fast-forward)", ""), { failure: "non_fast_forward", hook_side: null });
  assert.deepEqual(classify("", "fatal: Authentication failed; could not read from remote repository"), { failure: "auth", hook_side: null });
  assert.deepEqual(classify("", "fatal: could not resolve host example.invalid"), { failure: "network", hook_side: null });
  assert.deepEqual(classify("", "fatal: failed to push some refs"), { failure: "hook_rejected", hook_side: "local" });
  assert.deepEqual(classify("", "unexpected failure"), { failure: "unknown", hook_side: null });
});

test("credential redaction masks URL user info and the Noop gateway records a skipped push", async () => {
  assert.equal(redactCredentials("fatal https://user:secret@host.invalid/repo.git x-access-token:other-secret@host"), "fatal https://***@host.invalid/repo.git x-access-token:***@host");
  const gateway = new NoopGitGateway();
  const result = await gateway.pushBaseBranch({ work_id: "W1" });
  assert.equal(result.kind, "skipped_disabled");
  assert.equal(result.recorded, true);
  assert.equal(gateway.recordedOperations().at(-1).operation, "push_base_branch");
});
