import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ChildEmbedder, DEFAULT_EMBEDDER_CONFIG } from "../../dist/memory/embedder.js";
import { MemoryService } from "../../dist/memory/memory-service.js";
import { clippingText } from "./clipping-text.mjs";
import { writeModelFiles } from "./model-fixture.mjs";

const FAKE = new URL("./fixtures/fake-embedder-child.cjs", import.meta.url).pathname;

function makeVault() {
  const root = mkdtempSync(join(tmpdir(), "owl-targets-"));
  const vault = join(root, "vault");
  const write = (rel, text) => { mkdirSync(dirname(join(vault, rel)), { recursive: true }); writeFileSync(join(vault, rel), text); };
  write("research/a.md", clippingText("Orchard", "apple harvest"));
  write("materials/common/note.md", "apple material note\n");
  write("projects/kotori/theme.md", readFileSync(new URL("./fixtures/pages/theme.md", import.meta.url), "utf8"));
  mkdirSync(join(root, "data"));
  writeModelFiles(join(root, "models", "fake-model"));
  return { root, vault };
}

/** A fresh service over the same index, as after a server restart with another pageTypes setting. */
function open({ root, vault }, pageTypes) {
  const embedder = new ChildEmbedder({ ...DEFAULT_EMBEDDER_CONFIG, enabled: true, model: "fake-model", modelsDirs: [join(root, "models")], childPath: FAKE });
  const storage = { isAvailable: () => true, activeDir: () => vault, withRead: async (op) => op(), status: () => ({ available: true, dir: vault, since: null }) };
  return new MemoryService({ dataDir: join(root, "data"), storage, embedder, pageTypes, indexOptions: { watch: false } });
}

const chunkIds = (service, types) => service.index.db().prepare(`SELECT c.chunk_id AS id FROM note_chunks c JOIN notes n ON n.rowid = c.note_rowid WHERE n.page_type IN (${types.map(() => "?").join(",")}) ORDER BY id`).all(...types).map((r) => r.id);
const embeddedTypes = (service) => (service.index.db().prepare("SELECT DISTINCT n.page_type AS t FROM note_chunks c JOIN notes n ON n.rowid = c.note_rowid ORDER BY t").all()).map((r) => r.t);

test("vectors exist only for pageTypes; adding a type embeds just that type, removing one deletes its vectors", async () => {
  const dirs = makeVault();
  try {
    let service = open(dirs, DEFAULT_EMBEDDER_CONFIG.pageTypes);
    await service.start();
    await service.reindex({ mode: "full", embed: true });
    assert.deepEqual(embeddedTypes(service), ["clipping", "material"]);
    const before = chunkIds(service, ["clipping", "material"]);
    assert.ok(before.length > 0);
    await service.stop();

    service = open(dirs, [...DEFAULT_EMBEDDER_CONFIG.pageTypes, "theme"]);
    await service.start();
    await service.reindex({ mode: "diff", embed: true });
    assert.deepEqual(embeddedTypes(service), ["clipping", "material", "theme"]);
    assert.deepEqual(chunkIds(service, ["clipping", "material"]), before, "existing types are not re-embedded");
    await service.stop();

    service = open(dirs, ["clipping"]);
    await service.start();
    await service.reindex({ mode: "diff", embed: true });
    assert.deepEqual(embeddedTypes(service), ["clipping"]);
    const orphans = service.index.db().prepare("SELECT count(*) AS n FROM notes_vec WHERE rowid NOT IN (SELECT chunk_id FROM note_chunks)").get();
    assert.equal(orphans.n, 0, "removed vectors leave no rows in notes_vec");
    await service.stop();
  } finally {
    rmSync(dirs.root, { recursive: true, force: true });
  }
});
