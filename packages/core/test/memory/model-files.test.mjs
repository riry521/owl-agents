import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MODEL_FILES, downloadModel, enableIfUnset, findModelDir, hasModelFiles, isValidModelName, modelDirFor } from "../../dist/memory/model-files.js";

/** A throwaway server on 127.0.0.1 that serves every model file, except those listed in `missing` (404). */
async function withServer(missing, run) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    if (missing.some((file) => req.url.endsWith(`/${file}`))) { res.writeHead(404).end("no"); return; }
    res.writeHead(200).end(`body of ${req.url}`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const MODEL = "acme/tiny-embed";

test("downloadModel writes the configured model's files under its name and does not fetch them again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owl-model-files-"));
  try {
    await withServer([], async (host, requests) => {
      const first = await downloadModel({ model: MODEL, modelsDir: dir, host });
      assert.deepEqual(first.downloaded, [...MODEL_FILES]);
      assert.ok(hasModelFiles(modelDirFor(dir, MODEL)));
      assert.equal(findModelDir([dir], MODEL), modelDirFor(dir, MODEL));
      assert.equal(readFileSync(join(modelDirFor(dir, MODEL), "config.json"), "utf8"), `body of /${MODEL}/resolve/main/config.json`);
      const count = requests.length;
      const second = await downloadModel({ model: MODEL, modelsDir: dir, host });
      assert.deepEqual(second.downloaded, []);
      assert.deepEqual(second.skipped, [...MODEL_FILES]);
      assert.equal(requests.length, count, "no request on the second run");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a 404 fails the download and leaves no file under the final name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owl-model-files-"));
  try {
    await withServer(["tokenizer_config.json"], async (host) => {
      await assert.rejects(downloadModel({ model: MODEL, modelsDir: dir, host }), /tokenizer_config\.json.*404/u);
      const target = join(modelDirFor(dir, MODEL), "tokenizer_config.json");
      assert.equal(existsSync(target), false);
      assert.equal(existsSync(`${target}.part`), false, "the temp file is removed");
      assert.equal(findModelDir([dir], MODEL), null, "a partial model is not a model");
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid model names are rejected without any request or write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owl-model-files-"));
  try {
    await withServer([], async (host, requests) => {
      for (const model of ["../evil", "a/../b", "a/..", "no-slash", "a/b/c", "/abs/x", ""]) {
        assert.equal(isValidModelName(model), false, model);
        await assert.rejects(downloadModel({ model, modelsDir: dir, host }), /invalid model name/u);
      }
      assert.equal(requests.length, 0);
      assert.deepEqual(readdirSync(dir), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enableIfUnset writes enabled only when nothing decides it, keeps other keys, and refuses a broken file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "owl-enable-"));
  const file = join(dir, "memory-embedder.json");
  try {
    writeFileSync(file, JSON.stringify({ model: "a/b" }));
    assert.equal(await enableIfUnset(dir, {}), "written");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { model: "a/b", enabled: true });
    assert.equal(await enableIfUnset(dir, {}), "already_enabled");
    assert.equal(await enableIfUnset(dir, { OWL_MEMORY_EMBEDDINGS_ENABLED: "false" }), "disabled");
    writeFileSync(file, "{ broken");
    await assert.rejects(enableIfUnset(dir, {}), /not valid JSON/u);
    assert.equal(readFileSync(file, "utf8"), "{ broken", "the broken file is left as is");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
