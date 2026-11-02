import assert from "node:assert/strict";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { FailureWatchTrigger } from "../../packages/core/dist/auto-work/triggers/failure-notice.js";
import { PeriodicRunner } from "../../packages/core/dist/auto-work/periodic-runner.js";
import { FakeClock } from "../helpers/clock.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

// The log is read from the real disk, so a poll finishes after the fake clock has moved on.
const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

const T0 = new Date(2026, 5, 1, 10, 0, 0);
const seconds = (n) => new Date(T0.getTime() + n * 1000);
const minutes = (n) => seconds(n * 60);

const config = (watch, on = true) => ({
  enabled: { effective: on }, global_enabled: { effective: on },
  max_detail_chars: 4000,
  watch: { poll_seconds: 30, context_lines: 1, command_timeout_seconds: 60, logs: [], commands: [], ...watch },
});

function setup({ watch, commandRunner = async () => ({ exit_code: 0, stdout: "", stderr: "", timed_out: false }), projectPath = () => "/work/project" }) {
  const clock = new FakeClock(T0);
  const signals = [];
  const alerts = [];
  const trigger = new FailureWatchTrigger({ clock, commandRunner, projectPath, onAlert: (kind, detail) => alerts.push({ kind, detail }), logger: { warn: () => {} } });
  trigger.start(async (signal) => { signals.push(signal); }, config(watch), "proj1");
  return { clock, signals, alerts, trigger };
}

test("a log line that matches the pattern becomes a log_error signal with its context", async (t) => {
  const dir = await tempDir(t, "owl-auto-work-watch-");
  const path = join(dir, "app.log");
  await writeFile(path, "old ERROR before watching\n");
  const { clock, signals, trigger } = setup({ watch: { logs: [{ path, pattern: "ERROR \\w+", kind: "log_error" }] } });
  t.after(() => trigger.stop());
  await appendFile(path, "ok line\nERROR disk full\nnext line\n");
  await clock.advanceTo(seconds(30));
  await waitFor(() => signals.length === 1);
  const [signal] = signals;
  assert.equal(signal.source, "failure_notice");
  assert.equal(signal.kind, "log_error");
  assert.equal(signal.title, "ERROR disk full");
  assert.equal(signal.detail, "ok line\nERROR disk full\nnext line");
  assert.deepEqual(signal.dedupe, { kind: "text", value: "ERROR disk full" });
  assert.equal(signal.failure.log_path, path);
  await clock.advanceTo(seconds(60));
  await settle();
  assert.equal(signals.length, 1, "lines already read are not read again");
});

test("a file that gets shorter is read again from its start", async (t) => {
  const dir = await tempDir(t, "owl-auto-work-watch-");
  const path = join(dir, "app.log");
  await writeFile(path, "");
  const { clock, signals, trigger } = setup({ watch: { logs: [{ path, pattern: "FATAL", kind: "log_error" }] } });
  t.after(() => trigger.stop());
  await appendFile(path, "padding padding padding padding\nFATAL one\n");
  await clock.advanceTo(seconds(30));
  await waitFor(() => signals.length === 1);
  await writeFile(path, "FATAL two\n");
  await clock.advanceTo(seconds(60));
  await waitFor(() => signals.length === 2);
  assert.deepEqual(signals.map((signal) => signal.title), ["FATAL one", "FATAL two"]);
});

test("an unreadable log file is reported once and read when it appears", async (t) => {
  const dir = await tempDir(t, "owl-auto-work-watch-");
  const path = join(dir, "later.log");
  const { clock, signals, alerts, trigger } = setup({ watch: { logs: [{ path, pattern: "FATAL", kind: "log_error" }] } });
  t.after(() => trigger.stop());
  await clock.advanceTo(seconds(60));
  await waitFor(() => alerts.length >= 1);
  await settle();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, "auto_work_watch_failed");
  await writeFile(path, "FATAL arrived\n");
  await clock.advanceTo(seconds(90));
  await waitFor(() => signals.length === 1);
});

test("a command that exits with 1 becomes a process_failed signal; one that exits with 0 does not", async (t) => {
  const exits = [0, 1];
  const calls = [];
  const commandRunner = async (argv, cwd, timeoutMs) => {
    calls.push({ argv, cwd, timeoutMs });
    return { exit_code: exits.shift() ?? 0, stdout: "out", stderr: "boom", timed_out: false };
  };
  const { clock, signals, trigger } = setup({
    commandRunner,
    watch: { commands: [{ argv: ["./check.sh", "--quick"], interval_minutes: 5, kind: "process_failed" }] },
  });
  t.after(() => trigger.stop());
  await clock.advanceTo(minutes(4));
  assert.equal(calls.length, 0, "the first run is one interval after the start");
  await clock.advanceTo(minutes(5));
  assert.equal(signals.length, 0);
  await clock.advanceTo(minutes(10));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { argv: ["./check.sh", "--quick"], cwd: "/work/project", timeoutMs: 60_000 });
  assert.equal(signals.length, 1);
  const [signal] = signals;
  assert.equal(signal.kind, "process_failed");
  assert.equal(signal.title, "./check.sh --quick exited with code 1");
  assert.match(signal.detail, /boom/);
  assert.deepEqual(signal.dedupe, { kind: "id", value: "./check.sh\0--quick" });
  assert.deepEqual(signal.failure, { exit_code: 1, command: "./check.sh --quick", log_path: null });
});

test("a command that cannot start is reported and makes no signal", async (t) => {
  const { clock, signals, alerts, trigger } = setup({
    commandRunner: async () => { throw new Error("spawn ENOENT"); },
    watch: { commands: [{ argv: ["nope"], interval_minutes: 1, kind: "process_failed" }] },
  });
  t.after(() => trigger.stop());
  await clock.advanceTo(minutes(3));
  assert.equal(signals.length, 0);
  assert.equal(alerts.length, 1);
});

test("two settings for one log file both see the new lines", async (t) => {
  const dir = await tempDir(t, "owl-auto-work-watch-");
  const path = join(dir, "app.log");
  await writeFile(path, "");
  const { clock, signals, trigger } = setup({ watch: { logs: [{ path, pattern: "ERROR", kind: "log_error" }, { path, pattern: "WARN", kind: "other" }] } });
  t.after(() => trigger.stop());
  await appendFile(path, "ERROR one\nWARN two\n");
  await clock.advanceTo(seconds(30));
  await waitFor(() => signals.length === 2);
  assert.deepEqual(signals.map((signal) => [signal.kind, signal.title]), [["log_error", "ERROR one"], ["other", "WARN two"]]);
});

test("a command's own cwd is used; without one the Project's directory is", async (t) => {
  const calls = [];
  const commandRunner = async (argv, cwd) => { calls.push(cwd); return { exit_code: 0, stdout: "", stderr: "", timed_out: false }; };
  const { clock, trigger } = setup({
    commandRunner,
    watch: { commands: [{ argv: ["a"], interval_minutes: 1, kind: "process_failed", cwd: "/work/project/sub" }, { argv: ["b"], interval_minutes: 1, kind: "process_failed" }] },
  });
  t.after(() => trigger.stop());
  await clock.advanceTo(minutes(1));
  assert.deepEqual(calls.sort(), ["/work/project", "/work/project/sub"]);
});

test("nothing is read or run while disabled, and turning it off stops a running watch", async (t) => {
  const dir = await tempDir(t, "owl-auto-work-watch-");
  const path = join(dir, "app.log");
  await writeFile(path, "");
  let runs = 0;
  const commandRunner = async () => { runs += 1; return { exit_code: 1, stdout: "", stderr: "", timed_out: false }; };
  const watch = { logs: [{ path, pattern: "ERROR", kind: "log_error" }], commands: [{ argv: ["a"], interval_minutes: 1, kind: "process_failed" }] };
  const off = setup({ watch, commandRunner });
  t.after(() => off.trigger.stop());
  off.trigger.reconfigure(config(watch, false), "proj1");
  await appendFile(path, "ERROR one\n");
  await off.clock.advanceTo(minutes(2));
  await settle();
  assert.equal(runs, 0);
  assert.equal(off.signals.length, 0);

  const on = setup({ watch, commandRunner });
  t.after(() => on.trigger.stop());
  await on.clock.advanceTo(minutes(1));
  assert.equal(runs, 1);
  on.trigger.reconfigure(config(watch, false), "proj1");
  await on.clock.advanceTo(minutes(3));
  assert.equal(runs, 1);
});

test("PeriodicRunner does not run at once, does not overlap runs, and stops", async () => {
  const clock = new FakeClock(T0);
  let release;
  let runs = 0;
  const runner = new PeriodicRunner({ intervalMs: 1000, clock, run: () => { runs += 1; return new Promise((resolve) => { release = resolve; }); } });
  runner.start();
  assert.equal(runs, 0);
  await clock.advanceTo(seconds(1));
  assert.equal(runs, 1);
  assert.equal(runner.isRunning(), true);
  await clock.advanceTo(seconds(3));
  assert.equal(runs, 1, "a run still going is not stacked");
  release();
  const stopping = runner.stop();
  await stopping;
  await clock.advanceTo(seconds(10));
  assert.equal(runs, 1);
});
