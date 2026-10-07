import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePage, renderPage, validatePage } from "../../dist/memory/page-format.js";

const fixture = (kind) => readFileSync(new URL(`./fixtures/pages/${kind}.md`, import.meta.url), "utf8");

test("quoted scalars and array items follow parseScalar; commas inside quotes do not split", () => {
  const text = fixture("theme")
    .replace("type: theme", 'type: "theme"')
    .replace(/^title: .*$/mu, 'title: "落とし穴, と注意"')
    .replace(/^tags: .*$/mu, "tags: [\"a, b\", 'c', d]");
  const page = parsePage(text);
  assert.equal(page.kind, "theme");
  assert.equal(page.frontmatter.title, "落とし穴, と注意");
  assert.deepEqual(page.frontmatter.tags, ["a, b", "c", "d"]);
  assert.deepEqual(parsePage(renderPage(page)).frontmatter, page.frontmatter, "rendering keeps what quoting protects");
  assert.deepEqual(validatePage(page, { writer: "owl" }).errors, []);
  const quotedDate = fixture("work-log").replace(/^created: (.*)$/mu, 'created: "$1"');
  assert.equal(parsePage(quotedDate).frontmatter.created, parsePage(fixture("work-log")).frontmatter.created);
});

test("frontmatter values are checked by real type and calendar date for both writers", () => {
  const bad = [
    ["theme", (t) => t.replace(/^created: .*$/mu, "created: 2026-99-99"), "created"],
    ["theme", (t) => t.replace(/^updated: .*$/mu, "updated: 2026-02-30"), "updated"],
    ["theme", (t) => t.replace(/^integrated_at: .*$/mu, "integrated_at: 2026-13-01T00:00:00Z"), "integrated_at"],
    ["theme", (t) => t.replace(/^status: .*$/mu, "status: true"), "status"],
    ["clipping", (t) => t.replace(/^source_url: .*$/mu, "source_ref: true"), "source_url"],
    ["clipping", (t) => t.replace(/^source_url: .*$/mu, "source_ref: [x]"), "source_url"],
  ];
  for (const [kind, edit, key] of bad) {
    for (const writer of ["owl", "owner"]) {
      const result = validatePage(parsePage(edit(fixture(kind))), { writer });
      assert.ok(result.errors.some((e) => e.key === key), `${kind}/${key}/${writer}: ${JSON.stringify(result.errors)}`);
    }
  }
  const ref = parsePage(fixture("clipping").replace(/^source_url: .*$/mu, "source_ref: 手元の資料"));
  assert.deepEqual(validatePage(ref, { writer: "owl" }).errors, []);
});

test("string keys reject numbers, source_url must be a URL, and optional list keys are type-checked for both writers", () => {
  const bad = [
    ["theme", (t) => t.replace(/^title: .*$/mu, "title: 123"), "title"],
    ["theme", (t) => t.replace(/^summary: .*$/mu, "summary: 123"), "summary"],
    ["theme", (t) => t.replace(/^tags: .*$/mu, "tags: [a, b, c, d]"), "tags"],
    ["theme", (t) => t.replace(/^tags: .*$/mu, "tags: 5"), "tags"],
    ["theme", (t) => t.replace(/^updated: (.*)$/mu, "updated: $1\nrelated_projects: [not-a-ulid]"), "related_projects"],
    ["theme", (t) => t.replace(/^updated: (.*)$/mu, "updated: $1\nmerged_into: 123"), "merged_into"],
    ["clipping", (t) => t.replace(/^source_url: .*$/mu, "source_url: 123"), "source_url"],
    ["clipping", (t) => t.replace(/^source_url: .*$/mu, "source_url: definitely-not-a-url"), "source_url"],
    ["clipping", (t) => t.replace(/^source_url: .*$/mu, "source_url: ftp://example.com/x"), "source_url"],
    ["clipping", (t) => t.replace(/^project_ids: .*$/mu, "project_ids: [abc]"), "project_ids"],
    ["clipping", (t) => t.replace(/^project_ids: .*$/mu, "project_ids: 01HZZZZZZZZZZZZZZZZZZZZZZP"), "project_ids"],
    ["clipping", (t) => t.replace(/^tags: .*$/mu, "tags: 7"), "tags"],
    ["work-log", (t) => t.replace(/^title: .*$/mu, "title: 42"), "title"],
  ];
  for (const [kind, edit, key] of bad) {
    for (const writer of ["owl", "owner"]) {
      const result = validatePage(parsePage(edit(fixture(kind))), { writer });
      assert.ok(result.errors.some((e) => e.key === key), `${kind}/${key}/${writer}: ${JSON.stringify(result.errors)}`);
    }
  }
  for (const kind of ["theme", "project-index", "work-log", "clipping"]) {
    assert.deepEqual(validatePage(parsePage(fixture(kind)), { writer: "owl" }).errors, [], kind);
  }
});

test("status accepts active / dormant / archived and rejects anything else", () => {
  for (const status of ["active", "dormant", "archived"]) {
    const page = parsePage(fixture("theme").replace(/^status: .*$/mu, `status: ${status}`));
    assert.deepEqual(validatePage(page, { writer: "owl" }).errors, [], status);
  }
  for (const status of ["paused", "Dormant", "true"]) {
    const result = validatePage(parsePage(fixture("theme").replace(/^status: .*$/mu, `status: ${status}`)), { writer: "owl" });
    assert.ok(result.errors.some((e) => e.key === "status"), status);
  }
});

// project_id is checked whenever the key is present, required or not; an absent optional key stays fine.
const BAD_PROJECT_IDS = ["123", "not-a-ulid", "[abc]"];
const PROJECT_ID_CASES = [
  ["work-log", (t, v) => t.replace(/^project_id: .*$/mu, `project_id: ${v}`)],
  ["theme", (t, v) => t.replace("scope: project", "scope: common").replace(/^project_id: .*$/mu, `project_id: ${v}`)],
  ["project-index", (t, v) => t.replace("scope: project", "scope: common").replace(/^project_id: .*$/mu, `project_id: ${v}`)],
];

test("project_id values 123 / not-a-ulid / [abc] are rejected for work-log, theme (common) and project-index; absence stays optional", () => {
  for (const [kind, edit] of PROJECT_ID_CASES) {
    for (const value of BAD_PROJECT_IDS) {
      for (const writer of ["owl", "owner"]) {
        const result = validatePage(parsePage(edit(fixture(kind), value)), { writer });
        assert.ok(result.errors.some((e) => e.key === "project_id"), `${kind}/${value}/${writer}: ${JSON.stringify(result.errors)}`);
        assert.equal(result.ok, false);
      }
    }
    const absent = fixture(kind).replace("scope: project", "scope: common").replace(/^project_id: .*\n/mu, "");
    assert.deepEqual(validatePage(parsePage(absent), { writer: "owl" }).errors, [], `${kind}: absent project_id`);
    assert.deepEqual(validatePage(parsePage(edit(fixture(kind), "01HZZZZZZZZZZZZZZZZZZZZZZP")), { writer: "owl" }).errors, [], `${kind}: valid project_id`);
  }
  const project = fixture("theme").replace(/^project_id: .*\n/mu, "");
  assert.ok(validatePage(parsePage(project), { writer: "owl" }).errors.some((e) => e.code === "missing_key" && e.key === "project_id"), "scope: project still requires it");
});
