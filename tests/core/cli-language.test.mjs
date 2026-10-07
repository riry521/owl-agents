import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { cliLanguage } from "../../apps/server/dist/cli-language.js";
import { repoRoot } from "../helpers/paths.mjs";

test("CLI language prefers OWL_LANG, then LC_ALL, LC_MESSAGES, and LANG", () => {
  assert.equal(cliLanguage({ OWL_LANG: "ja", LC_ALL: "en_US.UTF-8" }), "ja");
  assert.equal(cliLanguage({ OWL_LANG: "en", LC_ALL: "ja_JP.UTF-8" }), "en");
  assert.equal(cliLanguage({ OWL_LANG: "other", LC_ALL: "ja_JP.UTF-8" }), "ja");
  assert.equal(cliLanguage({ LC_ALL: "ja_JP.UTF-8", LC_MESSAGES: "en_US" }), "ja");
  assert.equal(cliLanguage({ LC_MESSAGES: "ja_JP.UTF-8", LANG: "en_US" }), "ja");
  assert.equal(cliLanguage({ LANG: "ja_JP.UTF-8" }), "ja");
  assert.equal(cliLanguage({ LANG: "fr_FR.UTF-8" }), "en");
  assert.equal(cliLanguage({}), "en");
});

test("CLI help follows OWL_LANG before locale", () => {
  const help = (env) => execFileSync(process.execPath, ["apps/server/dist/cli.js", "--help"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.match(help({ OWL_LANG: "ja", LC_ALL: "en_US.UTF-8" }), /使い方:/u);
  assert.match(help({ OWL_LANG: "en", LC_ALL: "ja_JP.UTF-8" }), /Usage:/u);
});

test("setup.sh uses the same language priority", () => {
  const heading = (env) => execFileSync("bash", ["-c", "source <(sed -n '1,21p' setup.sh); msg 日本語 English"], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  assert.equal(heading({ OWL_LANG: "ja", LC_ALL: "en_US.UTF-8" }), "日本語");
  assert.equal(heading({ OWL_LANG: "en", LC_ALL: "ja_JP.UTF-8" }), "English");
  assert.equal(heading({ OWL_LANG: "", LC_ALL: "", LC_MESSAGES: "ja_JP.UTF-8" }), "日本語");
});
