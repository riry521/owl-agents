import assert from "node:assert/strict";
import { test } from "node:test";

import { spawnTestCommand } from "../../packages/core/dist/nightly-tests.js";

const run = (script, { limit = 1024, input, timeoutMs = 10_000 } = {}) =>
  spawnTestCommand([process.execPath, "-e", script], process.cwd(), { PATH: process.env.PATH ?? "" }, timeoutMs, limit, undefined, undefined, input);

test("input is written to stdin and stdin is closed", async () => {
  const result = await run("let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(s.toUpperCase()))", { input: "hello\nworld" });
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, "HELLO\nWORLD");
  assert.equal(result.stdout_truncated, false);
  assert.equal(result.stderr_truncated, false);
});

test("a process that never reads its stdin does not fail the call", async () => {
  const big = "x".repeat(1_000_000);
  const result = await run("process.stdout.write('done')", { input: big });
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, "done");
});

test("output over the limit is cut and flagged per stream", async () => {
  const result = await run("process.stdout.write('a'.repeat(100));process.stderr.write('b'.repeat(5))", { limit: 40 });
  assert.equal(result.stdout.length, 40);
  assert.equal(result.stdout_truncated, true);
  assert.equal(result.stderr, "bbbbb");
  assert.equal(result.stderr_truncated, false);
});

test("output exactly at the limit is not flagged", async () => {
  const result = await run("process.stdout.write('a'.repeat(40))", { limit: 40 });
  assert.equal(result.stdout.length, 40);
  assert.equal(result.stdout_truncated, false);
});

test("without input the child's stdin is closed", async () => {
  const result = await run("process.stdin.on('end',()=>process.stdout.write('ended')).resume()");
  assert.equal(result.stdout, "ended");
});
