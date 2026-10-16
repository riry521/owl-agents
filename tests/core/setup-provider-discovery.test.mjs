import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

import { tempDir } from "../helpers/temp.mjs";
import { run } from "../../scripts/setup-provider-discovery.mjs";

const baseEnv = "OWL_PROVIDER=stub\nOWL_PROVIDER_MODEL=m\n";
const custom = "OWL_PROVIDER=real\nOWL_PROVIDER_ADAPTER=codex-cli/v1\nOWL_CLAUDE_EXECUTABLE=/custom/claude\n";

async function setup(t, names, envText = baseEnv) {
  const root = await tempDir(t);
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const n of names) {
    await writeFile(join(bin, n), "#!/bin/sh\nexit 0\n");
    await chmod(join(bin, n), 0o755);
  }
  const config = join(root, "search.json");
  await writeFile(config, JSON.stringify({
    loginShell: false,
    dirs: ["~/bin"],
    providers: [
      { name: "claude", adapter: "claude-cli/v1", executableEnv: "OWL_CLAUDE_EXECUTABLE" },
      { name: "codex", adapter: "codex-cli/v1", executableEnv: "OWL_CODEX_EXECUTABLE" },
    ],
    installGuide: "INSTALL-GUIDE",
  }));
  const envFile = join(root, ".env");
  await writeFile(envFile, envText);
  const env = { HOME: root, PATH: "/usr/bin:/bin", OWL_PROVIDER_SEARCH_CONFIG: config };
  const lines = [];
  return { root, bin, envFile, env, lines, out: (s) => lines.push(s) };
}

const read = async (f) => Object.fromEntries((await readFile(f, "utf8")).split("\n").filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));

test("両方見つかると real・claude adapter・絶対パスを書く", async (t) => {
  const s = await setup(t, ["claude", "codex"]);
  await run(s);
  const e = await read(s.envFile);
  assert.equal(e.OWL_PROVIDER, "real");
  assert.equal(e.OWL_PROVIDER_ADAPTER, "claude-cli/v1");
  assert.equal(e.OWL_CLAUDE_EXECUTABLE, join(s.bin, "claude"));
  assert.equal(e.OWL_CODEX_EXECUTABLE, join(s.bin, "codex"));
});

test("ログインシェルの PATH からも見つける（偽シェル）", async (t) => {
  const s = await setup(t, ["codex"]);
  const sh = join(s.root, "fakeshell");
  await writeFile(sh, `#!/bin/sh\ncase "$2" in *codex*) echo ${join(s.bin, "codex")};; esac\n`);
  await chmod(sh, 0o755);
  const cfg = JSON.parse(await readFile(s.env.OWL_PROVIDER_SEARCH_CONFIG, "utf8"));
  cfg.loginShell = true;
  cfg.dirs = [];
  await writeFile(s.env.OWL_PROVIDER_SEARCH_CONFIG, JSON.stringify(cfg));
  await run({ ...s, env: { ...s.env, SHELL: sh } });
  assert.equal((await read(s.envFile)).OWL_CODEX_EXECUTABLE, join(s.bin, "codex"));
});

test("片方だけなら見つかった CLI の adapter とパスだけ書く", async (t) => {
  const s = await setup(t, ["codex"]);
  await run(s);
  const e = await read(s.envFile);
  assert.equal(e.OWL_PROVIDER, "real");
  assert.equal(e.OWL_PROVIDER_ADAPTER, "codex-cli/v1");
  assert.equal(e.OWL_CODEX_EXECUTABLE, join(s.bin, "codex"));
  assert.equal(e.OWL_CLAUDE_EXECUTABLE, undefined);
});

test("設定済みの項目は承認しなければ変えず、空の項目だけ埋める", async (t) => {
  const s = await setup(t, ["claude", "codex"], custom);
  await run({ ...s, approveOverwrite: false });
  const e = await read(s.envFile);
  assert.equal(e.OWL_PROVIDER_ADAPTER, "codex-cli/v1");
  assert.equal(e.OWL_CLAUDE_EXECUTABLE, "/custom/claude");
  assert.equal(e.OWL_CODEX_EXECUTABLE, join(s.bin, "codex"));
});

test("承認すると設定済みの項目も書き換える", async (t) => {
  const s = await setup(t, ["claude", "codex"], custom);
  await run({ ...s, approveOverwrite: async () => true });
  const e = await read(s.envFile);
  assert.equal(e.OWL_PROVIDER_ADAPTER, "claude-cli/v1");
  assert.equal(e.OWL_CLAUDE_EXECUTABLE, join(s.bin, "claude"));
});

test("非対話の CLI は承認なしとして扱う", async (t) => {
  const s = await setup(t, ["claude", "codex"], custom);
  const r = spawnSync(process.execPath, ["scripts/setup-provider-discovery.mjs", s.envFile], { env: s.env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const e = await read(s.envFile);
  assert.equal(e.OWL_CLAUDE_EXECUTABLE, "/custom/claude");
  assert.equal(e.OWL_CODEX_EXECUTABLE, join(s.bin, "codex"));
});

test("export や空白つきの既存設定も設定済みとして扱う", async (t) => {
  const s = await setup(t, ["claude"], "export OWL_PROVIDER_ADAPTER = custom/v1\nOWL_PROVIDER=stub\n");
  await run({ ...s, approveOverwrite: false });
  assert.match(await readFile(s.envFile, "utf8"), /^export OWL_PROVIDER_ADAPTER = custom\/v1$/m);
  await run({ ...s, approveOverwrite: true });
  const text = await readFile(s.envFile, "utf8");
  assert.equal(text.match(/OWL_PROVIDER_ADAPTER/g).length, 1);
  assert.equal((await read(s.envFile)).OWL_PROVIDER_ADAPTER, "claude-cli/v1");
});

test("ログインシェルには渡した HOME が届く", async (t) => {
  const s = await setup(t, ["codex"]);
  const sh = join(s.root, "fakeshell");
  await writeFile(sh, `#!/bin/sh\ncase "$2" in *codex*) [ "$HOME" = "${s.root}" ] && echo ${join(s.bin, "codex")};; esac\n`);
  await chmod(sh, 0o755);
  const cfg = JSON.parse(await readFile(s.env.OWL_PROVIDER_SEARCH_CONFIG, "utf8"));
  await writeFile(s.env.OWL_PROVIDER_SEARCH_CONFIG, JSON.stringify({ ...cfg, loginShell: true, dirs: [] }));
  const r = await run({ ...s, env: { ...s.env, SHELL: sh } });
  assert.equal(r.found.length, 1);
});

test("どちらも無ければ案内を出して .env を変えない", async (t) => {
  const s = await setup(t, []);
  await run(s);
  assert.ok(s.lines.join("\n").includes("INSTALL-GUIDE"));
  assert.equal(await readFile(s.envFile, "utf8"), baseEnv);
});
