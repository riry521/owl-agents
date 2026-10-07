import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { previousRecall5, setHash } from "../../../../scripts/memory-eval.mjs";

const rec = (extra, r5) => JSON.stringify({ split: "all", mode: "hybrid", metrics: { all: { recall_at_5: r5 } }, ...extra });

const withReports = (reports, fn) => {
  const out = mkdtempSync(join(tmpdir(), "prev-eval-"));
  try {
    mkdirSync(join(out, "memory-eval"));
    reports.forEach((r, i) => writeFileSync(join(out, "memory-eval", `${i + 1}.json`), r));
    fn(out, { split: "all", mode: "hybrid" });
  } finally { rmSync(out, { recursive: true, force: true }); }
};

const A = setHash("a\n");
const B = setHash("b\n");

test("previousRecall5 compares only with reports of the same set content and page_types", () => {
  withReports([
    rec({ set: "ja.jsonl", set_sha256: A, page_types: null }, 0.9),
    rec({ set: "clip.jsonl", set_sha256: B, page_types: ["clipping"] }, 0.3),
    rec({ set: "ja.jsonl", set_sha256: A, page_types: null }, 0.8),
  ], (out, base) => {
    assert.equal(previousRecall5(out, { ...base, setSha256: B, pageTypes: ["clipping"] }), 0.3);
    assert.equal(previousRecall5(out, { ...base, setSha256: A, pageTypes: null }), 0.8);
    assert.equal(previousRecall5(out, { ...base, setSha256: B, pageTypes: null }), null);
  });
});

test("previousRecall5 does not return a result of a same-named set with different content", () => {
  withReports([rec({ set: "clip.jsonl", set_sha256: A, page_types: ["clipping"] }, 0.9)], (out, base) => {
    assert.equal(previousRecall5(out, { ...base, setSha256: B, pageTypes: ["clipping"] }), null);
  });
});

test("previousRecall5 returns the result of a set with the same content", () => {
  withReports([rec({ set: "old-name.jsonl", set_sha256: A, page_types: ["clipping"] }, 0.5)], (out, base) => {
    assert.equal(previousRecall5(out, { ...base, setSha256: A, pageTypes: ["clipping"] }), 0.5);
  });
  withReports([rec({ set: "clip.jsonl", page_types: ["clipping"] }, 0.5)], (out, base) => {
    assert.equal(previousRecall5(out, { ...base, setSha256: A, pageTypes: ["clipping"] }), null);
  });
});
