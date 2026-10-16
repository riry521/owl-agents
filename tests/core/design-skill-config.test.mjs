import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { configuredDesignSkill } from "../../apps/server/dist/config.js";

async function withSkill(t, value, run) {
  const had = Object.hasOwn(process.env, "OWL_DESIGN_SKILL");
  const previous = process.env.OWL_DESIGN_SKILL;
  if (value === undefined) delete process.env.OWL_DESIGN_SKILL;
  else process.env.OWL_DESIGN_SKILL = value;
  const warnings = [];
  const warn = t.mock.method(console, "warn", (...args) => { warnings.push(args.join(" ")); });
  try {
    return await run(warnings);
  } finally {
    warn.mock.restore();
    if (had) process.env.OWL_DESIGN_SKILL = previous;
    else delete process.env.OWL_DESIGN_SKILL;
  }
}

test("an unset OWL_DESIGN_SKILL gives undefined", async (t) => {
  await withSkill(t, undefined, (warnings) => {
    assert.equal(configuredDesignSkill(), undefined);
    assert.deepEqual(warnings, []);
  });
});

test("a blank OWL_DESIGN_SKILL gives undefined without a warning", async (t) => {
  await withSkill(t, "   ", (warnings) => {
    assert.equal(configuredDesignSkill(), undefined);
    assert.deepEqual(warnings, []);
  });
});

test("a malformed OWL_DESIGN_SKILL warns once and gives undefined", async (t) => {
  await withSkill(t, "bad skill/../name", (warnings) => {
    assert.equal(configuredDesignSkill(), undefined);
    assert.equal(configuredDesignSkill(), undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /OWL_DESIGN_SKILL/u);
  });
});

test("a valid OWL_DESIGN_SKILL is returned trimmed and the server Core receives it as designSkill", async (t) => {
  await withSkill(t, "  example-ui-skill  ", (warnings) => {
    assert.equal(configuredDesignSkill(), "example-ui-skill");
    assert.deepEqual(warnings, []);
  });
  const source = await readFile(new URL("../../apps/server/src/core.ts", import.meta.url), "utf8");
  assert.match(source, /designSkill:\s*configuredDesignSkill\(\)/u);
});
