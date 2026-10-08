import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { repoRoot } from "../helpers/paths.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { waitFor } from "../helpers/wait.mjs";

const supervisorEntry = join(repoRoot, "apps/supervisor/dist/supervisor.js");

// Stand-in for apps/server/dist/cli.js. Behaviour is chosen by FAKE_CORE_MODE:
//   ok          - serve a healthy /api/v1/health on OWL_PORT
//   hang        - accept connections on OWL_PORT but never answer
//   crash-first - the first start exits 1 at once; later starts serve health after FAKE_CORE_DELAY_MS
// Every start, health request and SIGTERM is appended to FAKE_CORE_LOG.
const FAKE_CORE = `
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:http");
const log = (line) => appendFileSync(process.env.FAKE_CORE_LOG, line + "\\n");
log("start");
process.on("SIGTERM", () => { log("sigterm"); process.exit(0); });
setInterval(() => { if (process.ppid === 1) process.exit(0); }, 100);
const mode = process.env.FAKE_CORE_MODE;
const marker = process.env.FAKE_CORE_LOG + ".crashed";
if (mode === "crash-first" && !existsSync(marker)) { writeFileSync(marker, ""); process.exit(1); }
const server = createServer((request, response) => {
  log("health");
  if (mode === "hang") return;
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{}");
});
setTimeout(() => server.listen(Number(process.env.OWL_PORT), "127.0.0.1"), Number(process.env.FAKE_CORE_DELAY_MS ?? 0));
`;

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function fakeOwlRoot(t, prefix = "owl-supervisor-") {
  const root = await tempDir(t, prefix);
  mkdirSync(join(root, "apps/server/dist"), { recursive: true });
  writeFileSync(join(root, "apps/server/dist/cli.js"), FAKE_CORE);
  return { root, log: join(root, "core.log") };
}

function coreEvents(log) {
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
}

/** Run the supervisor with a fixed environment (OWL_ROOT keeps .env loading inside the temp root). */
function runSupervisor({ root, log, port, mode, delayMs, args, env = {} }) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      OWL_ROOT: root,
      OWL_PORT: String(port),
      FAKE_CORE_LOG: log,
      FAKE_CORE_MODE: mode,
      FAKE_CORE_DELAY_MS: String(delayMs ?? 0),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const exited = once(child, "exit");
  return {
    child,
    output: () => output,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      const [code, signal] = await exited;
      clearTimeout(timer);
      return { code, signal };
    },
  };
}

/** Run Supervisor with a short health-check interval through its exported class. */
function runSupervisorClass(options, intervalMs) {
  const script = `const { Supervisor } = await import(${JSON.stringify(pathToFileURL(supervisorEntry).href)});
await new Supervisor({ owlRoot: ${JSON.stringify(options.root)}, healthCheckIntervalMs: ${intervalMs} }).start();`;
  return runSupervisor({ ...options, args: ["--input-type=module", "-e", script] });
}

test("the supervisor starts Core with its own node binary even when PATH has no node, and forwards SIGTERM on shutdown", async (t) => {
  const { root, log } = await fakeOwlRoot(t);
  const supervisor = runSupervisor({
    root, log, port: await freePort(), mode: "ok", args: [supervisorEntry, `--root=${root}`], env: { PATH: "" },
  });
  try {
    await waitFor(() => coreEvents(log).includes("start"), { timeoutMs: 5_000, message: `Core start\n${supervisor.output()}` });
  } finally {
    const { code } = await supervisor.stop();
    assert.equal(code, 0, supervisor.output());
  }
  assert.ok(coreEvents(log).includes("sigterm"), "Core received SIGTERM before the supervisor exited");
});

test("the supervisor accepts a --root path that contains an equals sign", async (t) => {
  const { root, log } = await fakeOwlRoot(t, "owl-supervisor-a=b-");
  const supervisor = runSupervisor({ root, log, port: await freePort(), mode: "ok", args: [supervisorEntry, `--root=${root}`] });
  try {
    await waitFor(() => coreEvents(log).includes("start"), { timeoutMs: 5_000, message: `Core start\n${supervisor.output()}` });
  } finally {
    await supervisor.stop();
  }
});

test("the supervisor health check probes the port Core listens on (OWL_PORT)", async (t) => {
  const { root, log } = await fakeOwlRoot(t);
  const supervisor = runSupervisorClass({ root, log, port: await freePort(), mode: "ok" }, 100);
  try {
    await waitFor(() => coreEvents(log).includes("health"), { timeoutMs: 5_000, message: `a health probe\n${supervisor.output()}` });
  } finally {
    await supervisor.stop();
  }
  assert.doesNotMatch(supervisor.output(), /restarting owl-core/u);
});

test("a Core that accepts connections but never answers health is restarted within a few check intervals", async (t) => {
  const { root, log } = await fakeOwlRoot(t);
  const supervisor = runSupervisorClass({ root, log, port: await freePort(), mode: "hang" }, 200);
  try {
    await waitFor(() => /restarting owl-core/u.test(supervisor.output()), { timeoutMs: 5_000, message: `a health restart\n${supervisor.output()}` });
  } finally {
    await supervisor.stop();
  }
});

test("health failures seen while Core was down do not kill the Core restarted after a crash", async (t) => {
  const { root, log } = await fakeOwlRoot(t);
  // The 1s crash backoff spans several 300ms checks that fail while no Core runs; the restarted
  // Core needs 300ms before it answers, which is within its own three-check allowance.
  const supervisor = runSupervisorClass({ root, log, port: await freePort(), mode: "crash-first", delayMs: 300 }, 300);
  try {
    await waitFor(() => coreEvents(log).includes("health"), { timeoutMs: 8_000, message: `the restarted Core to answer\n${supervisor.output()}` });
  } finally {
    await supervisor.stop();
  }
  assert.doesNotMatch(supervisor.output(), /restarting owl-core/u);
  assert.equal(coreEvents(log).filter((event) => event === "start").length, 2, supervisor.output());
});
