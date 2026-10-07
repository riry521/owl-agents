import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { AdvisorSessionDriver } from "../../packages/agent-runtime/dist/index.js";
import { tempDir } from "../helpers/temp.mjs";

const baseEnv = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };

const FAKE_CLAUDE = `#!/usr/bin/env node
const readline = require("node:readline");
const turns = JSON.parse(process.env.FAKE_TURNS);
let index = 0;
readline.createInterface({ input: process.stdin }).on("line", () => {
  const lines = turns[index] ?? [];
  index += 1;
  if (index === 1) process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "fake-session" }) + "\\n");
  for (const line of lines) process.stdout.write(JSON.stringify(line) + "\\n");
});
`;

async function createDriver(t, turns) {
  const root = await tempDir(t, "owl-advisor-web-research-");
  const executable = join(root, "fake-claude");
  await writeFile(executable, FAKE_CLAUDE, "utf8");
  await chmod(executable, 0o755);
  const driver = await AdvisorSessionDriver.create({
    adapter: "claude",
    role: "advisor",
    model: "claude-test",
    cwd: root,
    env: { ...baseEnv, FAKE_TURNS: JSON.stringify(turns) },
    system_prompt: "test",
  }, executable);
  t.after(() => driver.stop("test", 1000));
  return driver;
}

async function collectTurn(driver, turnId) {
  const events = [];
  for await (const event of driver.events()) {
    events.push(event);
    if ((event.type === "turn.completed" || event.type === "turn.failed") && event.turn_id === turnId) break;
  }
  return events;
}

test("Advisor emits WebFetch research before the completed turn and prefers tool_use_result", async (t) => {
  const driver = await createDriver(t, [[
    { type: "assistant", message: { content: [{ type: "tool_use", id: "web-1", name: "WebFetch", input: { url: "https://example.com/page", prompt: "summarize" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "web-1", content: "Fallback result" }] }, tool_use_result: { code: 200, result: "# Structured title\nStructured body" } },
    { type: "result", subtype: "success", is_error: false, result: "Done." },
  ]]);

  await driver.send({ turn_id: "turn-1", text: "Research this" });
  const events = await collectTurn(driver, "turn-1");
  const researchIndex = events.findIndex((event) => event.type === "tool.web_research");
  const completeIndex = events.findIndex((event) => event.type === "turn.completed");
  assert.ok(researchIndex >= 0);
  assert.ok(completeIndex > researchIndex);
  assert.deepEqual(events[researchIndex], {
    type: "tool.web_research",
    turn_id: "turn-1",
    capture: {
      tool: "WebFetch",
      url: "https://example.com/page",
      query: null,
      prompt: "summarize",
      title: "Structured title",
      content: "# Structured title\nStructured body",
      links: [],
      http_status: 200,
      is_error: false,
    },
  });
  assert.equal(events[completeIndex].reply, "Done.");
});

test("Advisor extracts WebSearch links from Links text in tool_result", async (t) => {
  const driver = await createDriver(t, [[
    { type: "assistant", message: { content: [{ type: "tool_use", id: "search-1", name: "WebSearch", input: { query: "owl agents" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "search-1", content: "Search summary\nLinks: [{\"title\":\"Source\",\"url\":\"https://example.com/source\"}]\n" }] } },
    { type: "result", subtype: "success", is_error: false, result: "Done." },
  ]]);

  await driver.send({ turn_id: "turn-search", text: "Search this" });
  const events = await collectTurn(driver, "turn-search");
  const capture = events.find((event) => event.type === "tool.web_research")?.capture;
  assert.deepEqual(capture?.links, [{ title: "Source", url: "https://example.com/source" }]);
  assert.equal(capture?.query, "owl agents");
  assert.match(capture?.content ?? "", /Search summary/);
});

test("Advisor ignores other tools and malformed user records without failing the turn", async (t) => {
  const driver = await createDriver(t, [[
    { type: "assistant", message: { content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "echo hi" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "bash-1", content: "hi" }] } },
    { type: "user", message: { content: null } },
    { type: "result", subtype: "success", is_error: false, result: "Done." },
  ]]);

  await driver.send({ turn_id: "turn-malformed-user", text: "Run this" });
  const events = await collectTurn(driver, "turn-malformed-user");
  assert.equal(events.some((event) => event.type === "tool.web_research"), false);
  assert.equal(events.some((event) => event.type === "turn.failed"), false);
  assert.equal(events.at(-1)?.type, "turn.completed");
});

test("Advisor does not carry pending WebFetch calls into the next turn", async (t) => {
  const driver = await createDriver(t, [
    [
      { type: "assistant", message: { content: [{ type: "tool_use", id: "stale-web", name: "WebFetch", input: { url: "https://example.com/stale" } }] } },
      { type: "result", subtype: "success", is_error: false, result: "First." },
    ],
    [
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "stale-web", content: "Stale result" }] } },
      { type: "result", subtype: "success", is_error: false, result: "Second." },
    ],
  ]);

  await driver.send({ turn_id: "turn-1", text: "First" });
  await collectTurn(driver, "turn-1");
  await driver.send({ turn_id: "turn-2", text: "Second" });
  const events = await collectTurn(driver, "turn-2");
  assert.equal(events.some((event) => event.type === "tool.web_research"), false);
  assert.equal(events.at(-1)?.type, "turn.completed");
});

test("Advisor logs the error and reports tool.web_research_failed when extracting a web result throws", async (t) => {
  const driver = await createDriver(t, [[]]);
  await driver.send({ turn_id: "turn-extract-fail", text: "Research" });
  const input = new Proxy({}, { get() { throw new Error("extract exploded"); } });
  driver.pendingWebTools.set("web-bad", { name: "WebFetch", input });
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args);
  let events;
  try {
    events = driver.decodeLine(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "web-bad", content: "x" }] } }));
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(events, [{ type: "tool.web_research_failed", turn_id: "turn-extract-fail", error: "extract exploded" }]);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /extract exploded/);
});
