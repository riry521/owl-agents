import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeLocation } from "../packages/core/dist/index.js";

test("a timed-out probe stays single-flight until its pending stat completes", async (t) => {
  const base = await fs.mkdtemp(join(tmpdir(), "owl-kb-probe-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const dir = join(base, "store");
  await fs.mkdir(dir);
  await fs.writeFile(join(dir, ".owl-knowledge"), "{}");

  let holdNextStat = false;
  let blockedStatCalls = 0;
  let rootStatCalls = 0;
  let releaseStat;
  const pendingStat = new Promise((resolve) => { releaseStat = resolve; });
  let started;
  const statStarted = new Promise((resolve) => { started = resolve; });
  let markProbeFinished;
  const probeFinished = new Promise((resolve) => { markProbeFinished = resolve; });
  const location = new KnowledgeLocation({
    owlRoot: join(base, "root"),
    dataDir: join(base, "data"),
    persistence: { read: () => dir, write() {} },
    probeTimeoutMs: 25,
    pollIntervalMs: 60_000,
    unavailablePollIntervalMs: 60_000,
    fs: {
      ...fs,
      stat: async (path, ...args) => {
        if (path === dir) {
          rootStatCalls += 1;
          if (holdNextStat) {
            holdNextStat = false;
            blockedStatCalls += 1;
            started();
            return pendingStat;
          }
        }
        return fs.stat(path, ...args);
      },
      unlink: async (...args) => {
        const result = await fs.unlink(...args);
        if (String(args[0]).includes(".owl-probe-")) markProbeFinished();
        return result;
      },
    },
  });
  t.after(() => location.stop());
  assert.equal((await location.initialize()).state, "available");
  rootStatCalls = 0;
  holdNextStat = true;

  const first = location.check();
  await statStarted;
  assert.equal((await first).reason, "timeout");

  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal((await location.check()).reason, "timeout");
    }
    assert.equal(blockedStatCalls, 1);
    assert.equal(rootStatCalls, 1);
  } finally {
    releaseStat(await fs.stat(dir));
    await probeFinished;
  }

  // The probe's cleanup (after unlink) may still be settling; wait for single-flight to release.
  let recovered = await location.check();
  for (let i = 0; i < 50 && rootStatCalls === 1; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    recovered = await location.check();
  }
  assert.equal(recovered.state, "available", JSON.stringify(recovered));
  assert.equal(rootStatCalls, 2, "a new probe starts after the timed-out stat completes");
});
