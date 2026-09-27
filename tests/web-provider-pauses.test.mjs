import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { providerPauseLines, refreshProviderPauses } from "../apps/web/lib/provider-pauses.mjs";

const ja = JSON.parse(readFileSync(new URL("../apps/web/lib/i18n/ja.json", import.meta.url), "utf8"));
const en = JSON.parse(readFileSync(new URL("../apps/web/lib/i18n/en.json", import.meta.url), "utf8"));

function translate(dictionary, key, params = {}) {
  const template = key.split(".").reduce((value, part) => value?.[part], dictionary);
  assert.equal(typeof template, "string", `missing translation: ${key}`);
  return template.replace(/\{\{(\w+)\}\}/gu, (_, name) => params[name] ?? `{{${name}}}`);
}

const now = new Date("2026-09-27T01:00:00.000Z");
const reported = {
  provider: "anthropic",
  label: "Claude",
  state: "paused",
  paused_at: "2026-09-27T00:00:00.000Z",
  resume_at: "2026-09-27T06:00:00.000Z",
  resume_source: "reported",
  reported_resets_at: "2026-09-27T05:59:30.000Z",
  backoff_step: 0,
  last_error: null,
  last_role: "worker",
};

test("reported pauses use the provider label and formatted resume time", () => {
  const jaLine = providerPauseLines([reported], (key, params) => translate(ja, key, params), now, "Asia/Tokyo");
  const enLine = providerPauseLines([reported], (key, params) => translate(en, key, params), now, "Asia/Tokyo");

  assert.equal(jaLine[0].text, "Claude は利用上限のため停止中です。15:00ごろ再開予定");
  assert.match(enLine[0].text, /Claude.*3:00 PM/);
  assert.equal(jaLine[0].provider, reported.provider);
  assert.equal(jaLine[0].state, "paused");
});

test("backoff pauses say the reset time is unknown and include the next attempt time", () => {
  const pause = { ...reported, resume_source: "backoff", resume_at: "2026-09-27T06:15:00.000Z" };
  const jaLines = providerPauseLines([pause], (key, params) => translate(ja, key, params), now, "Asia/Tokyo");
  const enLines = providerPauseLines([pause], (key, params) => translate(en, key, params), now, "Asia/Tokyo");

  assert.equal(jaLines[0].text, "Claude は利用上限のため停止中です。解除時刻が分からないため、15:15ごろ再開を試します。");
  assert.match(enLines[0].text, /reset time is unknown.*3:15 PM/);
});

test("probing pauses say Owl is checking whether the provider resumed", () => {
  const pause = { ...reported, state: "probing" };
  const jaLine = providerPauseLines([pause], (key, params) => translate(ja, key, params), now, "Asia/Tokyo");
  const enLine = providerPauseLines([pause], (key, params) => translate(en, key, params), now, "Asia/Tokyo");

  assert.equal(jaLine[0].text, "Claude の再開を確認しています。");
  assert.match(enLine[0].text, /checking.*Claude/i);
});

test("times on another local date include the date in Japanese and English", () => {
  const pause = { ...reported, resume_at: "2026-09-28T06:00:00.000Z" };
  const jaLine = providerPauseLines([pause], (key, params) => translate(ja, key, params), now, "Asia/Tokyo");
  const enLine = providerPauseLines([pause], (key, params) => translate(en, key, params), now, "Asia/Tokyo");

  assert.match(jaLine[0].text, /9月28日.*15:00/u);
  assert.match(enLine[0].text, /Sep 28.*3:00 PM/u);
});

test("no pauses produce no banner lines", () => {
  assert.deepEqual(providerPauseLines([], (key, params) => translate(ja, key, params), now), []);
});

test("a failed refresh keeps the last known pause list", async () => {
  let pauses = [reported];
  await refreshProviderPauses(
    async () => { throw new Error("server unavailable"); },
    (next) => { pauses = next; },
  );

  assert.deepEqual(pauses, [reported]);
});
