import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { RuleStore } from "../../packages/core/dist/rule-store.js";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";
import { command as envelope, createTestCore } from "../helpers/core.mjs";
import { OutboundGuard } from "../../packages/core/dist/outbound-guard.js";
import { GuardTokenRegistry } from "../../apps/server/dist/guard-tokens.js";

function runHook({ role = "worker", apiBase, tokenFile, toolName, toolInput, cwd, owlRoot, nodeOptions, agentType }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, OWL_AGENT_ROLE: role, OWL_GUARD_API_BASE: apiBase, OWL_AGENT_CWD: cwd };
    if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
    if (owlRoot === undefined) delete env.OWL_ROOT;
    else env.OWL_ROOT = owlRoot;
    delete env.OWL_GUARD_TOKEN;
    if (tokenFile === undefined) delete env.OWL_GUARD_TOKEN_FILE;
    else env.OWL_GUARD_TOKEN_FILE = tokenFile;
    const child = spawn(process.execPath, [path.resolve("apps/server/dist/permission-hook.js")], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
    child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, cwd, ...(agentType === undefined ? {} : { agent_type: agentType }) }));
  });
}

test("PreToolUse hook enforces the live RuleStore API and fails closed when it is offline", async (t) => {
  const root = await tempDir(t, "owl-permission-hook-");
  const guardTokens = GuardTokenRegistry.open(path.join(root, "guard-tokens"));
  const workerLease = guardTokens.issue({ agent_run_id: "run-worker", role: "worker" });
  const advisorLease = guardTokens.issue({ agent_run_id: "run-advisor", role: "advisor" });
  const realHome = process.env.HOME;
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  try {
    const ruleStore = new RuleStore(process.cwd());
    await ruleStore.load();
    const api = await startTestHttpServer(t, { core: { ready: true }, webOut: root, owlRoot: root, ruleStore, guardTokens });
    if (!api) return t.skip("localhost listen is unavailable");
    const apiBase = api.baseUrl;
    const hookOptions = { apiBase, tokenFile: workerLease.file, cwd: root };

    const blocked = await runHook({ ...hookOptions, toolName: "Bash", toolInput: { command: "echo ok && git push -f" } });
    assert.equal(blocked.code, 0);
    assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.match(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecisionReason, /force|禁止/u);

    const leasedPush = await runHook({ ...hookOptions, toolName: "Bash", toolInput: { command: "git push --force-with-lease" } });
    assert.equal(leasedPush.code, 0);
    assert.equal(leasedPush.stdout, "");

    const outsideRead = await runHook({
      ...hookOptions,
      toolName: "Read",
      toolInput: { file_path: path.resolve("package.json") },
    });
    assert.equal(outsideRead.stdout, "");

    const secretRead = await runHook({
      ...hookOptions,
      toolName: "Read",
      toolInput: { file_path: path.join(root, ".env.local") },
    });
    assert.equal(JSON.parse(secretRead.stdout).hookSpecificOutput.permissionDecision, "deny");

    const mcpSecretRead = await runHook({
      ...hookOptions,
      toolName: "mcp__serena__read_file",
      toolInput: { relative_path: ".env.local" },
    });
    assert.equal(JSON.parse(mcpSecretRead.stdout).hookSpecificOutput.permissionDecision, "deny");

    const mcpSourceRead = await runHook({
      ...hookOptions,
      toolName: "mcp__serena__read_file",
      toolInput: { relative_path: "src/index.ts" },
    });
    assert.equal(mcpSourceRead.stdout, "");

    const denied = async (toolName, toolInput) =>
      JSON.parse((await runHook({ ...hookOptions, toolName, toolInput })).stdout).hookSpecificOutput.permissionDecision;
    for (const file_path of [
      path.join(root, ".env"),
      path.join(root, "secrets.json"),
      path.join(home, ".ssh", "x"),
      path.join(home, ".aws", "x"),
      path.join(home, ".config", "gh", "x"),
    ]) {
      assert.equal(await denied("Write", { file_path, content: "x" }), "deny", file_path);
      assert.equal(await denied("Edit", { file_path, old_string: "a", new_string: "b" }), "deny", file_path);
    }
    assert.equal(await denied("Bash", { command: `rm ${path.join(root, ".env")}` }), "deny");
    assert.equal(await denied("Bash", { command: `rm ${path.join(home, ".ssh", "x")}` }), "deny");
    const templateEdit = await runHook({
      ...hookOptions,
      toolName: "Edit",
      toolInput: { file_path: path.join(root, ".env.example"), old_string: "a", new_string: "b" },
    });
    assert.equal(templateEdit.stdout, "");
    const linkedTemplate = path.join(root, "linked", ".env.example");
    await mkdir(path.dirname(linkedTemplate), { recursive: true });
    await writeFile(path.join(root, "linked", ".env"), "x");
    await symlink(path.join(root, "linked", ".env"), linkedTemplate);
    assert.equal(await denied("Edit", { file_path: linkedTemplate, old_string: "a", new_string: "b" }), "deny");

    const advisorWrite = await runHook({
      ...hookOptions,
      role: "advisor",
      tokenFile: advisorLease.file,
      toolName: "Edit",
      toolInput: { file_path: "src/index.ts", old_string: "a", new_string: "b" },
    });
    assert.equal(advisorWrite.stdout, "");

    const advisorCreate = await runHook({
      ...hookOptions,
      role: "advisor",
      tokenFile: advisorLease.file,
      toolName: "Write",
      toolInput: { file_path: "src/new-file.ts", content: "text" },
    });
    assert.equal(advisorCreate.stdout, "");

    const sqlitePatch = await runHook({
      ...hookOptions,
      toolName: "apply_patch",
      toolInput: { command: "*** Begin Patch\n*** Update File: data/state.sqlite\n*** End Patch" },
    });
    assert.equal(JSON.parse(sqlitePatch.stdout).hookSpecificOutput.permissionDecision, "deny");

    const readonlySqlite = await runHook({
      ...hookOptions,
      toolName: "Bash",
      toolInput: { command: "sqlite3 -readonly data/state.sqlite 'select 1'" },
    });
    assert.equal(readonlySqlite.stdout, "");
    try {
      execFileSync("sqlite3", ["--version"], { stdio: "ignore" });
      const dataDir = path.join(root, "data");
      await mkdir(dataDir, { recursive: true });
      const databasePath = path.join(dataDir, "state.sqlite");
      execFileSync("sqlite3", [databasePath, "create table sample (value integer); insert into sample values (42);"]);
      const query = execFileSync("sqlite3", ["-readonly", databasePath, "select value from sample;"], { encoding: "utf8" }).trim();
      assert.equal(query, "42", "sqlite3 -readonly can run after the guard approves it");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  } finally {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    guardTokens.clear();
  }

  const offlineTokens = GuardTokenRegistry.open(path.join(root, "offline-tokens"));
  const offlineLease = offlineTokens.issue({ agent_run_id: "run-offline", role: "worker" });
  const offline = await runHook({
    role: "worker",
    apiBase: "http://127.0.0.1:1",
    tokenFile: offlineLease.file,
    cwd: root,
    toolName: "Bash",
    toolInput: { command: "echo safe" },
  });
  assert.equal(offline.code, 0);
  assert.equal(JSON.parse(offline.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(offline.stdout).hookSpecificOutput.permissionDecisionReason, /could not be reached/u);

  const offlineMcpPath = await runHook({
    role: "worker",
    apiBase: "http://127.0.0.1:1",
    tokenFile: offlineLease.file,
    cwd: root,
    toolName: "mcp__serena__read_file",
    toolInput: { relative_path: "src/index.ts" },
  });
  assert.equal(JSON.parse(offlineMcpPath.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("PreToolUse hook allows tool calls without path or command arguments without asking the guard", async () => {
  for (const [toolName, toolInput] of [
    ["mcp__serena__find_symbol", { name_path: "RuleStore/checkGuard" }],
    ["WebSearch", { query: "node test runner" }],
    ["mcp__slack__post_message", { channel: "C1", text: "hello" }],
  ]) {
    const result = await runHook({
      role: "worker",
      apiBase: "http://127.0.0.1:1",
      cwd: os.tmpdir(),
      toolName,
      toolInput,
    });
    assert.equal(result.code, 0, toolName);
    assert.equal(result.stdout, "", toolName);
  }
});

test("options of env, command, exec and time do not hide the wrapped command from block rules", async (t) => {
  const root = await tempDir(t, "owl-wrapper-options-");
  const ruleStore = new RuleStore(process.cwd());
  await ruleStore.load();
  for (const command of [
    "env -C /tmp git push -f",
    "env --chdir /tmp git push -f",
    "env --chdir=/tmp git push -f",
    "env -iC /tmp git push -f",
    "env -v git push -f",
    "env - git push -f",
    "env -- git push -f",
    "env -u FOO -- A=1 git push -f",
    "command -p git push -f",
    "command -- git push -f",
    "exec -a name git push -f",
    "exec -c git push -f",
    "time -o /tmp/out -p git push -f",
  ]) {
    assert.equal(ruleStore.checkCommand(command, root, root, "worker").blocked, true, command);
  }
  for (const command of ["env -C /tmp git push --force-with-lease", "command -v git"]) {
    assert.equal(ruleStore.checkCommand(command, root, root, "worker").blocked, false, command);
  }
});

test("the researcher subagent may call only its read tools, while the Worker itself and other subagents keep the normal guard", async (t) => {
  const root = await tempDir(t, "owl-researcher-hook-");
  const tokenFile = path.join(root, "token");
  await writeFile(tokenFile, "test-token\n");
  const asked = [];
  const guard = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      asked.push(JSON.parse(Buffer.concat(chunks).toString("utf8")).payload.tool_name);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: { allowed: true } }));
    });
  });
  await new Promise((resolve) => guard.listen(0, "127.0.0.1", resolve));
  t.after(() => guard.close());
  const hook = (agentType, toolName, toolInput) => runHook({ apiBase: `http://127.0.0.1:${guard.address().port}`, tokenFile, cwd: root, agentType, toolName, toolInput });
  const decision = (result) => (result.stdout === "" ? "pass" : JSON.parse(result.stdout).hookSpecificOutput.permissionDecision);
  const researcherDenied = (result) => result.stdout !== "" && /調べもの役は読み取り専用/u.test(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason);

  for (const cmd of ["sort -o target source", "uniq source target", "/tmp/x/cat a", "git -c core.pager=touch log", "git diff --output=out", "rg --pre ./x foo", "cat a > b", "ls"]) {
    assert.ok(researcherDenied(await hook("owl-researcher", "Bash", { command: cmd })), cmd);
  }
  for (const [tool, input] of [["Write", { file_path: path.join(root, "a"), content: "x" }], ["Edit", { file_path: path.join(root, "a") }], ["NotebookEdit", { notebook_path: path.join(root, "a.ipynb") }], ["Agent", { prompt: "x" }], ["Task", { prompt: "x" }], ["mcp__owl-memory__search", { query: "x" }], ["Foo", {}], ["toString", {}]]) {
    assert.ok(researcherDenied(await hook("owl-researcher", tool, input)), tool);
  }
  for (const [tool, input] of [["exec_command", { cmd: "sort -o t s" }], ["shell", { command: ["ls"] }], ["Bash", { command: "echo x > child.txt" }], ["apply_patch", { command: "*** Begin Patch\n*** Add File: child2.txt\n+y\n*** End Patch" }], ["spawn_agent", { message: "x" }], ["collaborationspawn_agent", { message: "x" }], ["Read", { file_path: path.join(root, "a.txt") }], ["Grep", { pattern: "x", path: root }], ["WebFetch", { url: "https://example.com" }], ["ToolSearch", { query: "x" }]]) {
    assert.ok(researcherDenied(await hook("owl_researcher", tool, input)), tool);
  }
  assert.equal(decision(await hook("owl_researcher", "web_search", { query: "x" })), "pass");
  assert.equal(decision(await hook("owl_researcher", "webrun", { search_query: [{ q: "x" }] })), "pass");
  asked.length = 0;
  assert.equal(decision(await hook(undefined, "apply_patch", { command: "*** Begin Patch\n*** Add File: parent.txt\n+p\n*** End Patch" })), "pass", "the parent Codex Worker keeps the normal guard");
  assert.deepEqual(asked, ["apply_patch"]);

  asked.length = 0;
  for (const [tool, input] of [["Read", { file_path: path.join(root, "a.txt") }], ["Grep", { pattern: "x", path: root }], ["Glob", { pattern: "*.ts", path: root }], ["WebSearch", { query: "x" }], ["ToolSearch", { query: "WebSearch" }]]) {
    assert.equal(decision(await hook("owl-researcher", tool, input)), "pass", tool);
  }
  assert.ok(asked.includes("Read"), "an allowed Read still goes to the guard");

  for (const agentType of [undefined, "general-purpose"]) {
    asked.length = 0;
    const result = await hook(agentType, "Bash", { command: "sort -o target source" });
    assert.equal(researcherDenied(result), false, String(agentType));
    assert.equal(decision(result), "pass", String(agentType));
    assert.deepEqual(asked, ["Bash"], String(agentType));
  }
});

test("a guard token answers only for its own role and only until it is released", async (t) => {
  const root = await tempDir(t, "owl-guard-token-");
  const guardTokens = GuardTokenRegistry.open(path.join(root, "guard-tokens"));
  const ruleStore = new RuleStore(process.cwd());
  await ruleStore.load();
  const api = await startTestHttpServer(t, { core: { ready: true }, webOut: root, owlRoot: root, ruleStore, guardTokens });
  if (!api) return t.skip("localhost listen is unavailable");
  try {
    const apiBase = api.baseUrl;
    const lease = guardTokens.issue({ agent_run_id: "run-1", role: "worker" });
    const token = (await readFile(lease.file, "utf8")).trim();
    assert.equal((await stat(lease.file)).mode & 0o777, 0o600);
    assert.equal((await stat(guardTokens.directory)).mode & 0o777, 0o700);
    assert.deepEqual(guardTokens.verify(token), { agent_run_id: "run-1", role: "worker" });
    const check = (role) => fetch(`${apiBase}/api/v1/guard/check`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        request_id: "r",
        idempotency_key: "k",
        expected_version: 0,
        payload: { role, tool_name: "Bash", tool_input: { command: "echo ok" }, cwd: root },
      }),
    });
    assert.equal((await check("worker")).status, 200);
    const otherRole = await check("advisor");
    assert.equal(otherRole.status, 403);
    assert.equal((await otherRole.json()).error.code, "agent_scope_denied");

    const hookAsAdvisor = await runHook({ role: "advisor", apiBase, tokenFile: lease.file, cwd: root, toolName: "Bash", toolInput: { command: "echo ok" } });
    assert.match(JSON.parse(hookAsAdvisor.stdout).hookSpecificOutput.permissionDecisionReason, /HTTP 403/u);

    lease.release();
    lease.release();
    assert.equal(guardTokens.verify(token), null);
    await assert.rejects(() => stat(lease.file), { code: "ENOENT" });
    assert.equal((await check("worker")).status, 401);

    const missingFile = await runHook({ apiBase, tokenFile: lease.file, cwd: root, toolName: "Bash", toolInput: { command: "echo ok" } });
    assert.match(JSON.parse(missingFile.stdout).hookSpecificOutput.permissionDecisionReason, /token could not be read/u);
    const noFile = await runHook({ apiBase, cwd: root, toolName: "Bash", toolInput: { command: "echo ok" } });
    assert.equal(JSON.parse(noFile.stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally {
    guardTokens.clear();
  }
});

test("outbound guard checks WebFetch and curl/wget destinations in the PreToolUse hook", async (t) => {
  const root = await tempDir(t, "owl-outbound-hook-");
  await mkdir(path.join(root, "rules", "system"), { recursive: true });
  await writeFile(path.join(root, "rules", "system", "outbound.yaml"), "blocked_hosts:\n  - blocked.example\n");
  // DNS never leaves the machine: a preload replaces dns.promises.lookup in the hook process.
  const preload = path.join(root, "dns-stub.mjs");
  await writeFile(preload, [
    'import dns from "node:dns";',
    'import { syncBuiltinESMExports } from "node:module";',
    'const map = { "public.example": ["93.184.216.34"], "rebind.example": ["93.184.216.34", "10.0.0.5"], "meta.example": ["169.254.169.254"], "blocked.example": ["93.184.216.34"], "api.blocked.example": ["93.184.216.34"] };',
    'dns.promises.lookup = async (host) => {',
    '  if (/(^|\\.)blocked\\.example\\.*$/i.test(host)) return [{ address: "93.184.216.34", family: 4 }];',
    '  if (!(host in map)) throw new Error("ENOTFOUND " + host);',
    '  return map[host].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));',
    "};",
    "syncBuiltinESMExports();",
    "",
  ].join("\n"));
  const guardTokens = GuardTokenRegistry.open(path.join(root, "guard-tokens"));
  t.after(() => guardTokens.clear());
  const lease = guardTokens.issue({ agent_run_id: "run-outbound", role: "worker" });
  const ruleStore = new RuleStore(process.cwd());
  await ruleStore.load();
  const api = await startTestHttpServer(t, { core: { ready: true }, webOut: root, owlRoot: root, ruleStore, guardTokens });
  if (!api) return t.skip("localhost listen is unavailable");
  const decide = async (toolName, toolInput, owlRoot = root) => {
    const result = await runHook({
      apiBase: api.baseUrl, tokenFile: lease.file, cwd: root, owlRoot, toolName, toolInput,
      nodeOptions: `--import=${pathToFileURL(preload).href}`,
    });
    assert.equal(result.code, 0);
    const output = result.stdout === "" ? null : JSON.parse(result.stdout).hookSpecificOutput;
    lastReason = output?.permissionDecisionReason ?? "";
    return output ? output.permissionDecision : "allow";
  };
  let lastReason = "";
  // The stub resolves every blocked.example spelling to a public address, so only the blocked_hosts match can deny it.
  const assertBlockedHost = (what) => assert.match(lastReason, /\(blocked_host\)/, `${what}: ${lastReason}`);
  const denied = [
    "http://localhost:8080/", "http://127.0.0.1/", "http://10.1.2.3/", "http://172.16.0.1/", "http://172.31.255.255/",
    "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://[fe80::1]/",
    "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/", "http://2130706433/", "https://blocked.example/x", "http://blocked.example./", "http://BLOCKED.example/", "http://api.Blocked.Example../", "https://api.blocked.example/",
  ];
  for (const url of denied) {
    const blocked = /blocked\.example/i.test(url);
    assert.equal(await decide("WebFetch", { url, prompt: "p" }), "deny", `WebFetch ${url}`);
    if (blocked) assertBlockedHost(`WebFetch ${url}`);
    for (const tool of ["curl", "wget"]) {
      assert.equal(await decide("Bash", { command: `${tool} -s ${url}` }), "deny", `${tool} ${url}`);
      if (blocked) assertBlockedHost(`${tool} ${url}`);
    }
  }
  for (const command of [
    "echo hi && curl -o out.txt 127.0.0.1:3000/x", "curl --url=http://127.0.0.1/", "curl --url http://10.0.0.1/", "wget --url=http://localhost/",
    "curl 2130706433", "curl -I http://127.0.0.1/", "curl -O http://169.254.169.254/", "wget -r http://10.0.0.1/", "wget -c http://localhost/", "curl -i http://127.0.0.1/", "wget -d http://10.0.0.1/", "curl 0x7f000001", "curl BLOCKED.EXAMPLE", "curl http://blocked.example./", "curl -sS 'http://169.254.169.254/'", "echo ok; curl -H 'X: y' http://192.168.0.1/ | cat",
    "curl rebind.example", "curl https://meta.example/", "wget https://missing.example/", "echo $(curl http://127.0.0.1/)",
  ]) {
    assert.equal(await decide("Bash", { command }), "deny", command);
    if (/blocked\.example/i.test(command)) assertBlockedHost(command);
  }
  for (const url of ["https://rebind.example/", "https://meta.example/", "https://missing.example/"]) {
    assert.equal(await decide("WebFetch", { url, prompt: "p" }), "deny", url);
  }

  for (const url of ["https://93.184.216.34/", "http://172.32.0.1/", "http://[2606:4700::1111]/", "https://public.example/x"]) {
    assert.equal(await decide("WebFetch", { url, prompt: "p" }), "allow", url);
    assert.equal(await decide("Bash", { command: `curl -fsSL ${url} -o out.txt` }), "allow", url);
    assert.equal(await decide("Bash", { command: `wget -q ${url}` }), "allow", url);
  }
  assert.equal(await decide("Bash", { command: "curl --url=https://public.example/ --retry 3 -o out.txt" }), "allow");
  assert.equal(await decide("Bash", { command: "curl https://93.184.216.34/ && echo localhost" }), "allow");
  assert.equal(await decide("Bash", { command: "echo http://127.0.0.1/ > notes.txt" }), "allow");

  // Shell wrappers, undeterminable destinations and rerouted connections.
  for (const command of [
    "bash -c 'curl http://127.0.0.1/'", "sh -c \"wget http://localhost/\"", "zsh -c 'curl http://10.0.0.1/'", "eval \"curl http://169.254.169.254/\"",
    "curl `printf http://127.0.0.1/`", "wget `cat f`", "echo `curl http://127.0.0.1/`",
    'https_proxy=http://127.0.0.1:8080 bash -c "curl https://93.184.216.34/"', "ALL_PROXY=socks5://localhost:1 eval 'wget http://example.com/'",
    "https_proxy=`printf http://127.0.0.1:8080` curl https://93.184.216.34/", "https_proxy=$(printf http://127.0.0.1:8080) curl https://93.184.216.34/",
    'wget -e "$PROXY_SETTING" http://93.184.216.34/',
    "{ curl http://127.0.0.1/; }", "if true; then curl http://127.0.0.1/; fi", "! curl http://127.0.0.1/", "while true; do wget http://localhost/; done",
    "timeout 5 curl http://127.0.0.1/", "xargs curl http://127.0.0.1/", "stdbuf -o0 curl http://127.0.0.1/", "bash -c -- 'curl http://127.0.0.1/'",
    "sudo bash -lc 'echo hi; curl 127.0.0.1'", "env -i curl http://127.0.0.1/", "nice -n 5 curl 127.0.0.1", "time -p wget http://localhost/", "sudo -u nobody bash -c 'curl 10.0.0.1'", 'curl "$URL"', "curl http://$HOST/", 'curl "$(echo http://127.0.0.1/)"', "curl -K f", "curl --config=f", "wget -i f", "wget --input-file=f",
    "curl --connect-to 93.184.216.34:80:127.0.0.1:80 http://93.184.216.34/", "curl --connect-to ::localhost: http://93.184.216.34/",
    "curl --proxy http://127.0.0.1:8080 http://93.184.216.34/", "curl -x http://127.0.0.1:8080 http://93.184.216.34/", "curl -xhttp://10.0.0.1:1 http://93.184.216.34/", "curl --preproxy socks5://127.0.0.1:1 http://93.184.216.34/",
    "curl --resolve example.com:80:10.0.0.1 http://example.com/", "curl --resolve public.example:80:93.184.216.34,127.0.0.1 http://public.example/",
    "wget -e http_proxy=http://127.0.0.1:8080 http://example.com/", "wget --execute=https_proxy=http://10.0.0.1:3128 https://example.com/",
    "https_proxy=http://127.0.0.1:8080 curl https://example.com/", "HTTP_PROXY=http://127.0.0.1:8080 curl http://example.com/", "ALL_PROXY=socks5://localhost:1080 curl http://example.com/", "all_proxy=http://127.0.0.1:1 wget http://example.com/",
  ]) {
    assert.equal(await decide("Bash", { command }), "deny", command);
  }
  for (const command of [
    "curl --proxy http://public.example:8080 http://93.184.216.34/", "curl --connect-to ::93.184.216.34: http://public.example/", "curl --resolve public.example:80:93.184.216.34 http://public.example/",
    "wget -e http_proxy=http://public.example:8080 http://93.184.216.34/", "https_proxy=http://public.example:8080 curl https://93.184.216.34/",
    "bash -c 'echo hello'", "sh -c 'ls -la'", "eval \"echo $HOME\"", "bash -c 'curl https://93.184.216.34/'",
  ]) {
    assert.equal(await decide("Bash", { command }), "allow", command);
  }

  // The guard cannot run: no OWL_ROOT, or an unreadable policy.
  assert.equal(await decide("WebFetch", { url: "https://93.184.216.34/", prompt: "p" }, ""), "deny");
  assert.equal(await decide("Bash", { command: "wget https://93.184.216.34/" }, ""), "deny");
  await writeFile(path.join(root, "rules", "system", "outbound.yaml"), "blocked_hosts: nope\n");
  assert.equal(await decide("WebFetch", { url: "https://93.184.216.34/", prompt: "p" }), "deny");
  assert.equal(await decide("Bash", { command: "curl https://93.184.216.34/" }), "deny");
  assert.equal(await decide("Bash", { command: "curl --url=https://93.184.216.34/" }), "deny");
  assert.equal(await decide("Bash", { command: "curl --url=https://93.184.216.34/" }, ""), "deny");

  // An Advisor is pointed at owl-api instead of curl; a Worker's reason stays as it was.
  await writeFile(path.join(root, "rules", "system", "outbound.yaml"), "blocked_hosts:\n  - blocked.example\n");
  const advisorLease = guardTokens.issue({ agent_run_id: "run-advisor-outbound", role: "advisor" });
  const asAdvisor = async (toolName, toolInput) => {
    const result = await runHook({ role: "advisor", apiBase: api.baseUrl, tokenFile: advisorLease.file, cwd: root, owlRoot: root, toolName, toolInput, nodeOptions: `--import=${pathToFileURL(preload).href}` });
    const output = result.stdout === "" ? null : JSON.parse(result.stdout).hookSpecificOutput;
    return { decision: output ? output.permissionDecision : "allow", reason: output?.permissionDecisionReason ?? "" };
  };
  for (const command of ['curl "$OWL_GUARD_API_BASE/api/v1/works"', `curl ${api.baseUrl}/api/v1/works`]) {
    const advisor = await asAdvisor("Bash", { command });
    assert.equal(advisor.decision, "deny", command);
    assert.match(advisor.reason, /owl-api/, command);
    assert.equal(await decide("Bash", { command }), "deny", command);
    assert.doesNotMatch(lastReason, /owl-api/, command);
  }
  assert.equal((await asAdvisor("Bash", { command: "curl https://public.example/" })).decision, "allow");

  // An Advisor's tools may not read the guard token directory (derived from OWL_GUARD_TOKEN_FILE).
  const tokenDir = path.dirname(advisorLease.file);
  for (const [toolName, toolInput] of [
    ["Read", { file_path: advisorLease.file }],
    ["Grep", { pattern: ".", path: tokenDir }],
    ["Bash", { command: 'cat "$OWL_GUARD_TOKEN_FILE"' }],
    ["Bash", { command: `ls ${tokenDir}` }],
  ]) {
    const advisor = await asAdvisor(toolName, toolInput);
    assert.equal(advisor.decision, "deny", `${toolName} ${JSON.stringify(toolInput)}`);
    assert.match(advisor.reason, /guard トークン/);
  }
  assert.equal((await asAdvisor("Read", { file_path: path.join(root, "notes.txt") })).reason.includes("guard トークン"), false);

  // Tools with no destination URL keep working, even with a broken guard.
  assert.equal(await decide("WebSearch", { query: "node test runner" }), "allow");
  assert.equal(await decide("WebSearch", { query: "node test runner" }, ""), "allow");
});

test("outbound guard refuses names that resolve to internal addresses and lookup failures", async () => {
  const guard = new OutboundGuard(os.tmpdir());
  const map = {
    "public.example": ["93.184.216.34"],
    "rebind.example": ["93.184.216.34", "10.0.0.5"],
    "meta.example": ["169.254.169.254"],
  };
  const resolve = async (host) => {
    if (!(host in map)) throw new Error("ENOTFOUND");
    return map[host];
  };
  assert.equal((await guard.checkUrlResolved("https://public.example/", null, "GET", resolve)).allowed, true);
  assert.equal((await guard.checkUrlResolved("https://rebind.example/", null, "GET", resolve)).rule, "internal_address");
  assert.equal((await guard.checkUrlResolved("https://meta.example/", null, "GET", resolve)).allowed, false);
  assert.equal((await guard.checkUrlResolved("https://missing.example/", null, "GET", resolve)).rule, "dns_failed");
});

test("opening the registry discards token files left by an earlier server", async (t) => {
  const root = await tempDir(t, "owl-guard-token-");
  const directory = path.join(root, "guard-tokens");
  const earlier = GuardTokenRegistry.open(directory);
  const stale = earlier.issue({ agent_run_id: "run-old", role: "worker" });
  const token = (await readFile(stale.file, "utf8")).trim();
  const current = GuardTokenRegistry.open(directory);
  assert.equal(current.verify(token), null);
  await assert.rejects(() => stat(stale.file), { code: "ENOENT" });
});

test("the guard endpoint denies a Reviewer the Project's test commands under both shell tool names and records the denial", async (t) => {
  const { core, db, root } = await createTestCore(t, { version: "reviewer-test-guard" }, { prefix: "owl-reviewer-test-guard-" });
  const created = await core.createProject(envelope({
    name: "P", canonical_path: path.join(root, "p"), base_branch: "main", allowed_roots: [root], verification_plan: [],
    test_run: { file_argv: ["node", "--test", "--test-reporter=tap", "{file}"] },
    test_policy: { reviewer_denied_commands: ["pnpm test"] },
  }, "reviewer-test-guard:create"));
  const now = new Date().toISOString();
  await db.createWriteLane().transact((transaction) => {
    transaction.run("INSERT INTO owners (id, display_name, created_at, updated_at) VALUES ('owner:default', 'Owner', ?, ?) ON CONFLICT DO NOTHING", now, now);
    transaction.run(
      `INSERT INTO works (id, owner_id, project_id, title, summary, size, state, rules_json, related_work_ids_json, created_at, updated_at)
       VALUES ('W1', 'owner:default', ?, 'Work', '', 'normal', 'running', '[]', '[]', ?, ?)`,
      created.data.id, now, now,
    );
    transaction.run(
      `INSERT INTO tasks (id, work_id, title, type, status, priority, context, acceptance, created_at, updated_at)
       VALUES ('T1', 'W1', 'Task', 'code', 'running', 'normal', '', '', ?, ?)`,
      now, now,
    );
    for (const [runId, role] of [["run-reviewer", "reviewer"], ["run-worker", "worker"]]) {
      transaction.run(
        `INSERT INTO agent_runs (id, work_id, task_id, role, provider, model, status, created_at, updated_at)
         VALUES (?, 'W1', 'T1', ?, 'anthropic', 'm', 'running', ?, ?)`,
        runId, role, now, now,
      );
    }
  });
  const guardTokens = GuardTokenRegistry.open(path.join(root, "guard-tokens"));
  const ruleStore = new RuleStore(root);
  await ruleStore.ensureDirectories();
  await ruleStore.load();
  t.after(() => guardTokens.clear());
  const api = await startTestHttpServer(t, { core, db, webOut: root, owlRoot: root, dataDir: root, ruleStore, guardTokens });
  if (!api) return t.skip("localhost listen is unavailable");
  const check = async (runId, role, toolName, shellCommand) => {
    const lease = guardTokens.issue({ agent_run_id: runId, role });
    const token = (await readFile(lease.file, "utf8")).trim();
    const response = await fetch(`${api.baseUrl}/api/v1/guard/check`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ request_id: "r", idempotency_key: "k", expected_version: 0, payload: { role, tool_name: toolName, tool_input: { command: shellCommand }, cwd: root } }),
    });
    lease.release();
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };

  for (const toolName of ["Bash", "shell"]) {
    assert.equal((await check("run-reviewer", "reviewer", toolName, "node --test a.test.mjs")).allowed, false, toolName);
  }
  const chained = await check("run-reviewer", "reviewer", "Bash", "cd x && node --test a.test.mjs");
  assert.equal(chained.allowed, false);
  assert.equal(chained.rule_id, "reviewer-test-command");
  assert.equal((await check("run-reviewer", "reviewer", "shell", "pnpm test")).allowed, false);
  assert.equal((await check("run-reviewer", "reviewer", "Bash", "pnpm build")).allowed, true);
  assert.equal((await check("run-reviewer", "reviewer", "Bash", "sh -c 'node --test a.test.mjs'")).rule_id, "reviewer-test-command");
  for (const wrapped of ['bash -c "pnpm test"', "eval 'node --test x'"]) {
    assert.equal((await check("run-reviewer", "reviewer", "Bash", wrapped)).rule_id, "reviewer-test-command", wrapped);
  }
  assert.equal((await check("run-worker", "worker", "Bash", "node --test a.test.mjs")).allowed, true);

  const events = db.all("SELECT payload_json FROM events WHERE type = 'reviewer.test_command_denied' AND task_id = 'T1'").map((row) => JSON.parse(row.payload_json));
  assert.equal(events.length, 7);
  assert.ok(events.every((payload) => payload.agent_run_id === "run-reviewer"));
  assert.ok(events.some((payload) => payload.command === "cd x && node --test a.test.mjs" && payload.matched === "node --test"));
});
