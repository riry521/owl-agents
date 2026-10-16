import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { createUlid } from "../../packages/db/dist/index.js";
import { MemoryIndex } from "../../packages/core/dist/memory/memory-index.js";
import { bodySha256, estimatePageTokens } from "../../packages/core/dist/memory/page-format.js";
import { PageLibrarian } from "../../packages/core/dist/memory/page-librarian.js";
import { tempDir } from "../helpers/temp.mjs";

const NOW = new Date("2026-10-05T12:00:00Z");

const conversation = (n) => `---
id: ${createUlid()}
type: conversation-log
title: 会話 2026-10-04-${n}
conversation_id: ${createUlid()}
session_id: ${createUlid()}
compaction_index: 1
cause: owl
summary_source: provider
extraction: pending
created: 2026-10-04
---
# 会話 2026-10-04-${n}

## 話したこと
- （司書待ち）

## 決まったこと
- （司書待ち）

## 学んだこと
- （司書待ち）

## 反映先
- （司書待ち）

## 原文
会話 ${n} の要約です。
`;

const clipping = (n) => `---
id: ${createUlid()}
type: clipping
title: 資料 ${n}
source_url: https://example.com/${n}
retrieved_at: 2026-10-01T05:00:00Z
retrieved_by: research-recorder
summary: 資料 ${n} の要約。
created: 2026-10-01
---
# 資料 ${n}

## 出典
- URL: https://example.com/${n}
- 取得: 2026-10-01（research-recorder）

## 要点
- 要点 ${n}

## 関係する Project
- （なし）
`;

/** A vault with `conversations` pending logs and `clippings` unused clippings; each file is `ageSeconds(i)` old. */
test("a large type: theme page under materials/ is not sent to the librarian and does not stop the run", async (t) => {
  const path = "materials/projects/horse-ai/big.md";
  const batch = { current: { max_items: 20, max_input_tokens: 60000 } };
  const env = await setup(t, { conversations: 2, batch, materials: { [path]: `---\ntype: theme\ntitle: 大きな構想\n---\n${"あ".repeat(67000)}\n` }, propose: async () => ({ ok: true, output: { operations: [] } }) });
  const report = await env.run();
  assert.notEqual(report.error, "input_over_limit");
  assert.ok(env.requests.length > 0);
  assert.ok(!JSON.stringify(env.requests).includes(path));
});

async function setup(t, { conversations, clippings = 0, materials = {}, batch, limits, propose, rebuildIndexes, themeRow, themeRows, router }) {
  const parent = await tempDir(t, "owl-librarian-batch-");
  const vault = join(parent, "vault");
  const dataDir = join(parent, "data");
  await mkdir(join(vault, "conversations", "2026-10"), { recursive: true });
  await mkdir(join(vault, "research"), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const files = [];
  const write = async (rel, text, i) => {
    const file = join(vault, rel);
    await writeFile(file, text);
    const at = new Date(NOW.getTime() - (10_000 - i) * 1000);
    await utimes(file, at, at);
    files.push(rel);
  };
  for (let i = 0; i < conversations; i += 1) await write(`conversations/2026-10/${i}.md`, conversation(i), i);
  for (let i = 0; i < clippings; i += 1) await write(`research/c${i}.md`, clipping(i), conversations + i);
  for (const [rel, text] of Object.entries(materials)) { await mkdir(dirname(join(vault, rel)), { recursive: true }); await writeFile(join(vault, rel), text); }
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  const index = new MemoryIndex({ dataDir, storage, watch: false });
  const requests = [];
  const librarian = new PageLibrarian({
    vault: { isAvailable: () => true, activeDir: () => vault, withWrite: (fn) => fn() }, dataDir,
    index: { refresh: () => index.refreshChanged(), listPages: (query) => (themeRows && query.types?.includes("theme") ? themeRows(files) : themeRow &&requests.length > 0 ? [themeRow(files[0])] : index.listPages(query)) },
    rebuildIndexes,
    router: router ?? { route: async () => ({ status: "appended", page: null }) },
    propose: async (request) => { requests.push(request); return propose(request, requests.length); },
    model: () => ({ provider: "claude", model: "m", effort: "low" }), batch: () => batch.current, limits, now: () => NOW, logger: { warn: () => undefined },
  });
  t.after(async () => { await index.stop(); });
  await index.start();
  await index.rebuild("manual");
  return { vault, dataDir, files, librarian, requests, run: () => librarian.run({ run_id: createUlid(), mode: "nightly" }) };
}

const takeAll = (request) => ({
  ok: true,
  output: {
    operations: [
      ...request.conversations.map((c) => ({ op: "take_conversation", conversation: c.path, h: c.h, items: [{ kind: "fact", text: `事実 ${c.path}` }] })),
      ...request.clippings.map((c) => ({ op: "set_usage", clipping: c.path, h: c.h, text: `使いどころ ${c.path}` })),
    ],
  },
});
const sent = (request) => [...request.conversations, ...request.clippings].map((x) => x.path);

test("a request holds at most max_items entries and max_input_tokens tokens however many are pending; the limits come from the setting", async (t) => {
  const batch = { current: { max_items: 20, max_input_tokens: 60000 } };
  const env = await setup(t, { conversations: 120, clippings: 10, batch, propose: async () => ({ ok: true, output: { operations: [] } }) });

  await env.run();
  assert.equal(sent(env.requests[0]).length, 20);
  assert.ok(estimatePageTokens(JSON.stringify(env.requests[0])) <= 60000);

  batch.current = { max_items: 7, max_input_tokens: 60000 };
  await env.run();
  assert.equal(sent(env.requests[1]).length, 7);

  const whole = estimatePageTokens(JSON.stringify(env.requests[1]));
  batch.current = { max_items: 130, max_input_tokens: whole };
  await env.run();
  const request = env.requests[2];
  assert.ok(sent(request).length > 0 && sent(request).length < 130, `sent ${sent(request).length}`);
  assert.ok(estimatePageTokens(JSON.stringify(request)) <= whole);
});

test("what an earlier run processed is not sent again, and a failed run leaves its entries for the next one", async (t) => {
  const batch = { current: { max_items: 2, max_input_tokens: 60000 } };
  const env = await setup(t, {
    conversations: 4, clippings: 1, batch,
    propose: async (request, call) => (call === 2 ? { ok: false, error: "provider_down" } : takeAll(request)),
  });

  const first = await env.run();
  assert.equal(first.applied, 2);
  const failed = await env.run();
  assert.equal(failed.error, "provider_down");
  await env.run();
  await env.run();

  const [one, two, three, four] = env.requests.map(sent);
  assert.equal(new Set([...one, ...two]).size, 4, "a run that processed nothing is retried with the unprocessed entries only");
  assert.deepEqual(three, two);
  assert.equal(new Set([...one, ...three, ...four]).size, one.length + three.length + four.length, "no entry is processed twice");
  assert.equal(four.length, 1);
  for (const rel of one) assert.doesNotMatch(await readFile(join(env.vault, rel), "utf8"), /extraction: pending|^## 使いどころ\n- （なし）/mu);
});

test("a write failure on one entry leaves only that entry pending, and an input that cannot fit the limit is not sent", async (t) => {
  const batch = { current: { max_items: 10, max_input_tokens: 60000 } };
  const env = await setup(t, { conversations: 1, batch, propose: async (request) => takeAll(request) });
  await mkdir(join(env.vault, "conversations", "2026-11"), { recursive: true });
  const second = "conversations/2026-11/late.md";
  await writeFile(join(env.vault, second), conversation("late"));
  await chmod(join(env.vault, "conversations", "2026-11"), 0o555); // the second entry cannot be written
  const failed = await env.librarian.run({ run_id: createUlid(), mode: "nightly" });
  await chmod(join(env.vault, "conversations", "2026-11"), 0o755);
  assert.equal(failed.applied, 1);
  assert.deepEqual(failed.rejected.map((r) => r.code), ["write_failed"]);
  assert.doesNotMatch(await readFile(join(env.vault, env.files[0]), "utf8"), /extraction: pending/u);
  assert.match(await readFile(join(env.vault, second), "utf8"), /extraction: pending/u);

  await env.run();
  assert.deepEqual(sent(env.requests[1]), [second]);

  await writeFile(join(env.vault, "conversations", "2026-11", "next.md"), conversation("next"));
  batch.current = { max_items: 10, max_input_tokens: 1 };
  const before = env.requests.length;
  assert.equal((await env.run()).error, "input_over_limit");
  assert.equal(env.requests.length, before);
});

test("a failure while writing theme or index pages does not undo entries already settled", async (t) => {
  const batch = { current: { max_items: 10, max_input_tokens: 60000 } };
  const env = await setup(t, {
    conversations: 2, batch, propose: async (request) => takeAll(request),
    themeRow: (path) => ({ path, page_scope: "common", project_id: null }),
    rebuildIndexes: async () => { throw new Error("index write denied"); },
  });
  const failed = await env.run();
  assert.match(failed.error, /^write_failed:/u);
  assert.equal(failed.applied, 2);
  for (const rel of env.files) assert.doesNotMatch(await readFile(join(env.vault, rel), "utf8"), /extraction: pending/u);
  assert.equal((await env.librarian.pendingStats()).pending_conversations, 0);
});

test("pendingStats counts pending conversations and unused clippings and reports the age of the oldest", async (t) => {
  const batch = { current: { max_items: 100, max_input_tokens: 60000 } };
  const env = await setup(t, { conversations: 3, clippings: 2, batch, propose: async (request) => takeAll(request) });
  assert.deepEqual(await env.librarian.pendingStats(), { pending_conversations: 3, unused_clippings: 2, oldest_pending_age_seconds: 10_000 });
  await env.run();
  assert.deepEqual(await env.librarian.pendingStats(), { pending_conversations: 0, unused_clippings: 0, oldest_pending_age_seconds: null });
});

test("run repeats batches while pending shrinks; it stops when pending is 0, does not shrink, or max_batches is reached", async (t) => {
  const batch = { current: { max_items: 2, max_input_tokens: 60000, max_batches: 10 } };
  const env = await setup(t, {
    conversations: 5, batch, propose: async (request) => takeAll(request),
    themeRows: (files) => [{ path: files[0], page_scope: "common", project_id: null, owl_new_count: 1 }],
  });
  const report = await env.run();
  assert.deepEqual(env.requests.map((r) => sent(r).length), [2, 2, 1, 0], "theme lines left over (remaining) keep the run going once more after pending hits 0; a batch with no progress then stops it");
  assert.equal(report.llm_calls, env.requests.length);
  assert.equal((await env.librarian.pendingStats()).pending_conversations, 0);

  const idle = await setup(t, { conversations: 3, batch, propose: async () => ({ ok: true, output: { operations: [] } }) });
  await idle.run();
  assert.equal(idle.requests.length, 1, "no progress stops the loop");

  const capped = { current: { max_items: 2, max_input_tokens: 60000, max_batches: 2 } };
  const limited = await setup(t, { conversations: 10, batch: capped, propose: async (request) => takeAll(request) });
  await limited.run();
  assert.equal(limited.requests.length, capped.current.max_batches);
  assert.equal((await limited.librarian.pendingStats()).pending_conversations, 10 - capped.current.max_batches * capped.current.max_items);
});

test("manual run with paths is one batch; manual without paths loops like nightly", async (t) => {
  const batch = { current: { max_items: 2, max_input_tokens: 60000, max_batches: 10 } };
  const env = await setup(t, { conversations: 5, batch, propose: async (request) => takeAll(request) });
  await env.librarian.run({ run_id: createUlid(), mode: "manual", paths: [env.files[0]] });
  assert.equal(env.requests.length, 1);

  await env.librarian.run({ run_id: createUlid(), mode: "manual" });
  assert.equal(env.requests.length, 1 + Math.ceil(3 / batch.current.max_items));
});

/** A theme page whose `決まりごと` carries `lines`; long lines leave the template valid but can push the page past its own size limit. */
const withFacts = (page, lines) => page.replace("## 決まりごと\n（なし）\n", `## 決まりごと\n${lines.join("\n")}\n`);

/** What `MemoryIndex` says about a theme page written by hand: the request only reads the scope, the project, the path and the status from it. */
const themeRowOf = (path, title) => ({ path, title, summary: `${title}の要約`, page_scope: "common", project_id: null, status: "active", owl_new_count: 0 });

/** Lines long enough to push a theme page past its own size limit, short enough for one request to still hold their items. */
const overLimitLines = (count, length) => Array.from({ length: count }, (_, i) => `- 決まりごとその${i}：${"あ".repeat(length)}`);

test("an over-limit page too big for max_input_tokens goes in without its items and into warnings, and the batch is still sent", async (t) => {
  const themePath = "themes/over_input_limit.md";
  const title = "上限を超えるテーマ";
  // 400 lines of 200 characters: the page's items alone are several times max_input_tokens, so no request within the limit can carry them.
  const lines = overLimitLines(400, 200);
  const batch = { current: { max_items: 200, max_input_tokens: 60000 } };
  const env = await setup(t, {
    conversations: 5, batch,
    propose: async () => ({ ok: true, output: { operations: [] } }),
    themeRows: () => [themeRowOf(themePath, title)],
  });
  await mkdir(join(env.vault, "themes"), { recursive: true });
  await writeFile(join(env.vault, themePath), withFacts(themePage(createUlid(), title), lines));

  const report = await env.run();
  assert.notEqual(report.error, "input_over_limit");
  assert.ok(env.requests.length >= 1, "the model is still called");
  const request = env.requests[0];
  const page = request.pages.find((p) => p.path === themePath);
  assert.equal(page.over_limit, true, "the page really is over its own limit");
  assert.equal(page.items, null, "a page too big for the request is sent without its items");
  assert.ok(request.conversations.length > 0, "the waiting logs are sent all the same");
  assert.equal(request.conversations.length, 5, "the room the page could not use goes to the logs");
  assert.deepEqual(report.warnings.filter((w) => w.page === themePath).map((w) => w.code), ["page_items_over_input_limit"], "the page is reported once");
});

test("over-limit pages whose items fit max_input_tokens keep them, and the entries that do not fit are left out instead", async (t) => {
  const themePath = "themes/over_theme_limit.md";
  const title = "上限のテーマ";
  // Three long lines: enough to push the page over its own limit, small enough for one request to hold the items.
  const lines = overLimitLines(3, 1200);
  const pending = 4 + 3;
  const batch = { current: { max_items: 1, max_input_tokens: 60000 } };
  const env = await setup(t, {
    conversations: 4, clippings: 3, batch,
    propose: async () => ({ ok: true, output: { operations: [] } }),
    themeRows: () => [themeRowOf(themePath, title)],
  });
  await mkdir(join(env.vault, "themes"), { recursive: true });
  await writeFile(join(env.vault, themePath), withFacts(themePage(createUlid(), title), lines));

  // One entry, everything else left out: the room this request takes is the page's items plus a single entry.
  await env.run();
  const room = estimatePageTokens(JSON.stringify(env.requests[0]));
  batch.current = { max_items: 20, max_input_tokens: room };
  const report = await env.run();
  assert.notEqual(report.error, "input_over_limit");
  const request = env.requests[1];
  const page = request.pages.find((p) => p.path === themePath);
  assert.equal(page.over_limit, true);
  assert.equal(page.items?.find((s) => s.section === "決まりごと")?.items.length, lines.length, "the items of an over-limit page that fit are sent");
  assert.ok(estimatePageTokens(JSON.stringify(request)) <= room, "the whole request stays within max_input_tokens");
  assert.ok(
    sent(request).length > 0 && sent(request).length < pending,
    `the entries take only the room left after the page, never the page's own room: ${sent(request).length} of ${pending}`,
  );
});

test("the run's own input limit never takes the room of an over-limit page or of the entries", async (t) => {
  const themePath = "themes/over_run_limit.md";
  const title = "実行上限のテーマ";
  const lines = overLimitLines(3, 1200);
  // `limits.input_tokens: 1` is smaller than any single item here: a page or an entry measured against it alone would be left out.
  const batch = { current: { max_items: 20, max_input_tokens: 60000, max_batches: 1 } };
  const env = await setup(t, {
    conversations: 3, batch, limits: { input_tokens: 1 },
    propose: async () => ({ ok: true, output: { operations: [] } }),
    themeRows: () => [themeRowOf(themePath, title)],
  });
  await mkdir(join(env.vault, "themes"), { recursive: true });
  await writeFile(join(env.vault, themePath), withFacts(themePage(createUlid(), title), lines));

  const report = await env.run();
  assert.notEqual(report.error, "input_over_limit");
  const request = env.requests[0];
  const page = request.pages.find((p) => p.path === themePath);
  assert.equal(page.over_limit, true);
  assert.equal(page.items?.find((s) => s.section === "決まりごと")?.items.length, lines.length, "a page over its own limit keeps the items a roomy max_input_tokens can hold");
  assert.equal(request.conversations.length, 3, "and the entries never had that limit applied to them either");
  assert.deepEqual(report.warnings, []);
});

test("the entries waiting for the librarian take their room before a page with nothing to do", async (t) => {
  const themePath = "themes/quiet.md";
  const title = "静かなテーマ";
  const batch = { current: { max_items: 20, max_input_tokens: 60000, max_batches: 1 } };
  const env = await setup(t, {
    conversations: 3, batch,
    propose: async () => ({ ok: true, output: { operations: [] } }),
    themeRows: () => [themeRowOf(themePath, title)],
  });
  await mkdir(join(env.vault, "themes"), { recursive: true });
  await writeFile(join(env.vault, themePath), withFacts(themePage(createUlid(), title), overLimitLines(8, 300)));

  // A roomy request shows what everything costs: what the request pays without items and entries is fixed, the rest is the page's items.
  await env.run();
  const whole = env.requests[0];
  const page = whole.pages.find((p) => p.path === themePath);
  assert.equal(page.over_limit, false, "the page is inside its own limits: it is an ordinary page with nothing new");
  const fixed = estimatePageTokens(JSON.stringify({ ...whole, pages: whole.pages.map((p) => ({ ...p, items: null })), conversations: [], clippings: [] }));
  const items = estimatePageTokens(JSON.stringify(page.items));

  // One token more than the page's items: the entries fit, the page and the entries together do not.
  const room = fixed + items + 1;
  batch.current = { max_items: 20, max_input_tokens: room, max_batches: 1 };
  const report = await env.run();
  const request = env.requests[1];
  assert.notEqual(report.error, "input_over_limit");
  assert.equal(request.conversations.length, 3, "the logs waiting to be read are sent before a page that has nothing new");
  assert.equal(request.pages.find((p) => p.path === themePath).items, null, "the room the page cannot have goes unsent, not the entries");
  assert.ok(estimatePageTokens(JSON.stringify(request)) <= room, "the whole request stays within max_input_tokens");
});

const themePage = (id, title) => `---
id: ${id}
type: theme
title: ${title}
summary: ${title}の要約
scope: common
status: active
integrated_hash:
integrated_at:
created: 2026-09-20
updated: 2026-10-01
---
# ${title}

## 概要
${title}の概要。

## 決まりごと
（なし）

## 落とし穴
（なし）

## 手順
（なし）

## 関連ページ
（なし）

## 更新履歴
- 2026-09-28 W812 新規作成
`;

test("a batch 2 failure keeps batch 1 results and settled inputs and restores only theme / index", async (t) => {
  const batch = { current: { max_items: 2, max_input_tokens: 60000, max_batches: 2 } };
  const themeA = "themes/a.md";
  const themeB = "themes/b.md";
  const themeC = "themes/c.md";
  const homePath = "Home.md";
  let rebuilds = 0;
  let vault;
  const afterBatch1 = {};
  const env = await setup(t, {
    conversations: 4, batch,
    propose: async (request, n) => {
      const out = takeAll(request);
      out.output.operations.push({ op: "link", from: themeA, to: n === 1 ? themeB : themeC, relation: `関連 batch ${n}` });
      return out;
    },
    themeRows: () => [themeA, themeB, themeC].map((path) => ({ path, page_scope: "common", project_id: null })),
    rebuildIndexes: async (_scopes, backup) => {
      rebuilds += 1;
      await backup(homePath);
      await writeFile(join(vault, homePath), `index after batch ${rebuilds}`);
      if (rebuilds === 1) afterBatch1.theme = await readFile(join(vault, themeA), "utf8");
      if (rebuilds === 2) throw new Error("index write denied");
    },
  });
  vault = env.vault;
  await mkdir(join(vault, "themes"), { recursive: true });
  const originalTheme = themePage(createUlid(), "テーマ A");
  await writeFile(join(vault, themeA), originalTheme);
  await writeFile(join(vault, themeB), themePage(createUlid(), "テーマ B"));
  await writeFile(join(vault, themeC), themePage(createUlid(), "テーマ C"));
  await writeFile(join(vault, homePath), "index original");
  const report = await env.librarian.run({ run_id: createUlid(), mode: "nightly" });
  assert.match(report.error, /^write_failed:/u);
  assert.equal(env.requests.length, batch.current.max_batches);
  assert.ok(!existsSync(join(env.dataDir, "backups")), "no backup files are written");
  for (const rel of env.files) {
    assert.doesNotMatch(await readFile(join(env.vault, rel), "utf8"), /extraction: pending/u, "settled inputs stay");
  }
  assert.notEqual(afterBatch1.theme, originalTheme, "batch 1 wrote the theme page");
  assert.match(afterBatch1.theme, /関連 batch 1/u);
  assert.equal(await readFile(join(vault, themeA), "utf8"), afterBatch1.theme, "the theme page is restored to batch 1's content");
  assert.equal(await readFile(join(vault, homePath), "utf8"), "index after batch 1", "only the failed batch's index write is undone");
  assert.equal((await env.librarian.pendingStats()).pending_conversations, 0);
});

test("a rejected take_conversation does not undo lines another writer added to a theme page after the router wrote", async (t) => {
  const batch = { current: { max_items: 2, max_input_tokens: 60000, max_batches: 1 } };
  const themeA = "themes/a.md";
  let vault;
  let calls = 0;
  const append = async (line) => writeFile(join(vault, themeA), (await readFile(join(vault, themeA), "utf8")).replace("## 決まりごと\n", `## 決まりごと\n${line}\n`));
  const env = await setup(t, {
    conversations: 1, batch,
    propose: async (request) => ({ ok: true, output: { operations: request.conversations.map((c) => ({ op: "take_conversation", conversation: c.path, h: c.h, items: [{ kind: "fact", text: "一つ目" }, { kind: "fact", text: "二つ目" }] })) } }),
    themeRows: () => [{ path: themeA, page_scope: "common", project_id: null }],
    router: {
      route: async () => {
        calls += 1;
        if (calls === 1) { await append("- 司書が足した行"); return { status: "appended", page: themeA }; }
        await append("- 別の書き手が足した行");
        return { status: "rejected", reason: "template_invalid", page: null };
      },
    },
  });
  vault = env.vault;
  await mkdir(join(vault, "themes"), { recursive: true });
  await writeFile(join(vault, themeA), themePage(createUlid(), "テーマ A"));
  const report = await env.run();
  assert.ok(report.rejected.some((r) => r.code.startsWith("route_failed")), JSON.stringify(report.rejected));
  assert.match(await readFile(join(vault, themeA), "utf8"), /別の書き手が足した行/u);
});

test("a router that throws mid take_conversation is undone like a rejected route and leaves the conversation pending", async (t) => {
  const batch = { current: { max_items: 2, max_input_tokens: 60000, max_batches: 1 } };
  const themeA = "themes/a.md";
  let vault;
  let calls = 0;
  const env = await setup(t, {
    conversations: 1, batch,
    propose: async (request) => ({ ok: true, output: { operations: request.conversations.map((c) => ({ op: "take_conversation", conversation: c.path, h: c.h, items: [{ kind: "fact", text: "一つ目" }, { kind: "fact", text: "二つ目" }] })) } }),
    themeRows: () => [{ path: themeA, page_scope: "common", project_id: null }],
    router: {
      route: async () => {
        calls += 1;
        if (calls > 1) throw new Error("router broke");
        const text = await readFile(join(vault, themeA), "utf8");
        await writeFile(join(vault, themeA), text.replace("## 決まりごと\n", "## 決まりごと\n- 司書が足した行\n"));
        return { status: "appended", page: themeA };
      },
    },
  });
  vault = env.vault;
  await mkdir(join(vault, "themes"), { recursive: true });
  const original = themePage(createUlid(), "テーマ A");
  await writeFile(join(vault, themeA), original);
  const report = await env.run();
  assert.ok(report.rejected.some((r) => r.code === "route_failed:thrown:router broke"), JSON.stringify(report));
  assert.doesNotMatch(await readFile(join(vault, themeA), "utf8"), /司書が足した行/u);
  assert.match(await readFile(join(vault, env.files[0]), "utf8"), /extraction: pending/u);
});

test("a rejected take_conversation keeps a line another writer added after the router wrote, using the router's own hash", async (t) => {
  const batch = { current: { max_items: 2, max_input_tokens: 60000, max_batches: 1 } };
  const themeA = "themes/a.md";
  let vault;
  let calls = 0;
  const env = await setup(t, {
    conversations: 1, batch,
    propose: async (request) => ({ ok: true, output: { operations: request.conversations.map((c) => ({ op: "take_conversation", conversation: c.path, h: c.h, items: [{ kind: "fact", text: "一つ目" }, { kind: "fact", text: "二つ目" }] })) } }),
    themeRows: () => [{ path: themeA, page_scope: "common", project_id: null }],
    router: {
      route: async () => {
        calls += 1;
        if (calls > 1) return { status: "rejected", reason: "template_invalid" };
        const text = await readFile(join(vault, themeA), "utf8");
        const written = text.replace("## 決まりごと\n", "## 決まりごと\n- 司書が足した行\n");
        await writeFile(join(vault, themeA), written);
        const written_hash = bodySha256(written);
        await writeFile(join(vault, themeA), written.replace("## 決まりごと\n", "## 決まりごと\n- 別の書き手が足した行\n")); // lands between the router and adopt
        return { status: "appended", page: themeA, written_hash };
      },
    },
  });
  vault = env.vault;
  await mkdir(join(vault, "themes"), { recursive: true });
  await writeFile(join(vault, themeA), themePage(createUlid(), "テーマ A"));
  const report = await env.run();
  assert.ok(report.rejected.some((r) => r.code.startsWith("route_failed")), JSON.stringify(report.rejected));
  assert.match(await readFile(join(vault, themeA), "utf8"), /別の書き手が足した行/u);
});

test("a rejected take_conversation keeps a line another writer added after the librarian's own check and before the next route wrote", async (t) => {
  const batch = { current: { max_items: 3, max_input_tokens: 60000, max_batches: 1 } };
  const themeA = "themes/a.md";
  let vault;
  let calls = 0;
  const env = await setup(t, {
    conversations: 1, batch,
    propose: async (request) => ({ ok: true, output: { operations: request.conversations.map((c) => ({ op: "take_conversation", conversation: c.path, h: c.h, items: [{ kind: "fact", text: "一つ目" }, { kind: "fact", text: "二つ目" }, { kind: "fact", text: "三つ目" }] })) } }),
    themeRows: () => [{ path: themeA, page_scope: "common", project_id: null }],
    router: {
      // Honours the router contract: inside its lease it reports the own_hashes pages that no longer match, then writes.
      route: async (input) => {
        calls += 1;
        if (calls > 2) return { status: "rejected", reason: "template_invalid" };
        if (calls === 2) await writeFile(join(vault, themeA), (await readFile(join(vault, themeA), "utf8")).replace("## 決まりごと\n", "## 決まりごと\n- 別の書き手が足した行\n"));
        const text = await readFile(join(vault, themeA), "utf8");
        const foreign_pages = Object.entries(input.own_hashes ?? {}).filter(([page, hash]) => page === themeA && bodySha256(text) !== hash).map(([page]) => page);
        const written = text.replace("## 決まりごと\n", "## 決まりごと\n- 司書が足した行\n");
        await writeFile(join(vault, themeA), written);
        return { status: "appended", page: themeA, written_hash: bodySha256(written), ...(foreign_pages.length > 0 ? { foreign_pages } : {}) };
      },
    },
  });
  vault = env.vault;
  await mkdir(join(vault, "themes"), { recursive: true });
  await writeFile(join(vault, themeA), themePage(createUlid(), "テーマ A"));
  const report = await env.run();
  assert.ok(report.rejected.some((r) => r.code.startsWith("route_failed")), JSON.stringify(report.rejected));
  assert.match(await readFile(join(vault, themeA), "utf8"), /別の書き手が足した行/u);
});

test("a rejected take_conversation keeps a line another writer added between two successful routes to the same page", async (t) => {
  const batch = { current: { max_items: 3, max_input_tokens: 60000, max_batches: 1 } };
  const themeA = "themes/a.md";
  let vault;
  let calls = 0;
  const env = await setup(t, {
    conversations: 1, batch,
    propose: async (request) => ({ ok: true, output: { operations: request.conversations.map((c) => ({ op: "take_conversation", conversation: c.path, h: c.h, items: [{ kind: "fact", text: "一つ目" }, { kind: "fact", text: "二つ目" }, { kind: "fact", text: "三つ目" }] })) } }),
    themeRows: () => [{ path: themeA, page_scope: "common", project_id: null }],
    router: {
      route: async () => {
        calls += 1;
        if (calls > 2) return { status: "rejected", reason: "template_invalid" };
        const text = await readFile(join(vault, themeA), "utf8");
        const written = text.replace("## 決まりごと\n", "## 決まりごと\n- 司書が足した行\n");
        await writeFile(join(vault, themeA), written);
        const written_hash = bodySha256(written);
        // After the first route returns its hash, another writer appends; the second route then hashes that line in too.
        if (calls === 1) await writeFile(join(vault, themeA), written.replace("## 決まりごと\n", "## 決まりごと\n- 別の書き手が足した行\n"));
        return { status: "appended", page: themeA, written_hash };
      },
    },
  });
  vault = env.vault;
  await mkdir(join(vault, "themes"), { recursive: true });
  await writeFile(join(vault, themeA), themePage(createUlid(), "テーマ A"));
  const report = await env.run();
  assert.ok(report.rejected.some((r) => r.code.startsWith("route_failed")), JSON.stringify(report.rejected));
  assert.match(await readFile(join(vault, themeA), "utf8"), /別の書き手が足した行/u);
});
