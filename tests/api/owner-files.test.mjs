import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { ExternalCoreAdapter } from "../../apps/server/dist/core.js";
import { createTestCore } from "../helpers/core.mjs";
import { startTestHttpServer } from "../helpers/http.mjs";
import { tempDir } from "../helpers/temp.mjs";

const token = "owner-files-token";
const WAV = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 3, 4, 5, 6, 7]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);

const put = async (dir, rel, body) => {
  await mkdir(join(dir, rel, ".."), { recursive: true });
  await writeFile(join(dir, rel), body);
};

/** Core with a materials folder and a shared folder, served over HTTP either directly or behind the production adapter. */
async function setup(t, { wrap }) {
  const shared = await tempDir(t, "owl-owner-files-shared-");
  const outside = await tempDir(t, "owl-owner-files-outside-");
  const { root, db, core } = await createTestCore(t, { getAdvisorFolders: () => ({ sharedDir: shared, screenshotDir: shared }) }, { prefix: "owl-owner-files-" });
  const port = wrap ? new ExternalCoreAdapter(core, db, root, join(root, "data")) : core;
  if (wrap) t.after(() => port.shutdown({ force: true, timeoutMs: 0 }).catch(() => undefined));
  const api = await startTestHttpServer(t, { core: port, db, webOut: root, owlRoot: root }, { token });
  if (!api) return null;
  const materials = join(root, "knowledge", "materials");
  await mkdir(materials, { recursive: true });
  await put(materials, "demo/index.html", '<audio src="./sound.wav"></audio>');
  await put(materials, "demo/sound.wav", WAV);
  await put(materials, "demo/sub/a.wav", WAV);
  await put(materials, "demo/image.png", PNG);
  await put(materials, "demo/note.md", "# メモ\n");
  await put(materials, "demo/clip.mp4", "video-bytes");
  await put(materials, "demo/.env", "SECRET=1");
  await put(materials, "demo/id_rsa", "KEY");
  await put(outside, "leak.txt", "LEAKED");
  await symlink(join(outside, "leak.txt"), join(materials, "demo", "link.txt"));
  await symlink(outside, join(materials, "demo", "outdir"));
  await put(shared, "hello.txt", "shared hello");
  const auth = { headers: { authorization: `Bearer ${token}` } };
  const get = async (path, init = auth) => {
    const response = await fetch(`${api.baseUrl}/api/v1/owner-files${path}`, { redirect: "manual", ...init });
    return { response, status: response.status, type: response.headers.get("content-type"), body: Buffer.from(await response.arrayBuffer()) };
  };
  // fetch() folds ".." and "%2e%2e" before sending, so traversal needs a literal request line.
  const raw = (path) => new Promise((resolve, reject) => {
    const url = new URL(api.baseUrl);
    const req = httpRequest({ host: url.hostname, port: url.port, path: `/api/v1/owner-files${path}`, headers: auth.headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
  return { get, raw, materials, shared, outside, api };
}

for (const wrap of [false, true]) {
  const label = wrap ? "behind ExternalCoreAdapter" : "directly on Core";

  test(`serves files with browser-ready types, resolves relative URLs, and lists roots from settings (${label})`, async (t) => {
    const s = await setup(t, { wrap });
    if (!s) return t.skip("localhost listen is unavailable");

    const roots = await s.get("/roots");
    assert.equal(roots.status, 200);
    assert.deepEqual(JSON.parse(roots.body).data.roots, [
      { key: "materials", path: await realpath(s.materials) },
      { key: "shared", path: await realpath(s.shared) },
    ]);

    const cases = [
      ["/materials/demo/index.html", 200, /^text\/html/u, Buffer.from('<audio src="./sound.wav"></audio>')],
      ["/materials/demo/sound.wav", 200, /^audio\/wav$/u, WAV],
      ["/materials/demo/image.png", 200, /^image\/png$/u, PNG],
      ["/materials/demo/note.md", 200, /^text\/(markdown|plain)/u, Buffer.from("# メモ\n")],
      ["/materials/demo/clip.mp4", 200, /^video\/mp4$/u, Buffer.from("video-bytes")],
      ["/shared/hello.txt", 200, /^text\/plain/u, Buffer.from("shared hello")],
    ];
    for (const [path, status, type, body] of cases) {
      const res = await s.get(path);
      assert.equal(res.status, status, path);
      assert.match(res.type, type, path);
      assert.equal(res.response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(res.body, body, path);
    }

    const indexUrl = new URL("/api/v1/owner-files/materials/demo/index.html", s.api.baseUrl);
    for (const [relative, body] of [["./sound.wav", WAV], ["sub/a.wav", WAV]]) {
      const res = await s.get(new URL(relative, indexUrl).pathname.replace("/api/v1/owner-files", ""));
      assert.equal(res.status, 200, relative);
      assert.equal(res.type, "audio/wav");
      assert.deepEqual(res.body, body);
    }

    const ranged = await s.get("/materials/demo/sound.wav", { headers: { authorization: `Bearer ${token}`, range: "bytes=4-7" } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.response.headers.get("content-range"), "bytes 4-7/12");
    assert.deepEqual(ranged.body, WAV.subarray(4, 8));
  });

  test(`refuses paths outside the folders, traversal, escaping symlinks and secrets (${label})`, async (t) => {
    const s = await setup(t, { wrap });
    if (!s) return t.skip("localhost listen is unavailable");
    const cases = [
      ["get", "/other/demo/index.html"],
      ["raw", "/materials/../../etc/passwd"],
      ["raw", "/materials/demo/../../../../etc/passwd"],
      ["raw", "/materials/demo/%2e%2e/%2e%2e/%2e%2e/etc/passwd"],
      ["raw", "/materials/demo/..%2f..%2fetc/passwd"],
      ["get", "/materials/demo/link.txt"],
      ["get", "/materials/demo/outdir/leak.txt"],
      ["get", "/materials/demo/.env"],
      ["get", "/materials/demo/id_rsa"],
    ];
    for (const [how, path] of cases) {
      const res = await s[how](path);
      assert.ok(res.status >= 400 && res.status < 500, `${path} -> ${res.status}`);
      for (const secret of ["LEAKED", "SECRET=1", "KEY", "root:"]) assert.ok(!res.body.toString().includes(secret), `${path} leaked ${secret}`);
    }
  });

  test(`lists a folder as HTML whose links lead on, and redirects to a trailing slash (${label})`, async (t) => {
    const s = await setup(t, { wrap });
    if (!s) return t.skip("localhost listen is unavailable");

    const redirect = await s.get("/materials/demo");
    assert.equal(redirect.status, 308);
    assert.equal(redirect.response.headers.get("location"), "/api/v1/owner-files/materials/demo/");

    const page = await s.get("/materials/demo/");
    assert.equal(page.status, 200);
    assert.match(page.type, /^text\/html/u);
    const html = page.body.toString();
    assert.match(html, /name="viewport"/u);
    assert.ok(!/\.env|id_rsa|link\.txt|outdir/u.test(html), "secrets and escaping links are not listed");
    const hrefs = [...html.matchAll(/href="([^"]+)"/gu)].map((m) => m[1]);
    assert.ok(hrefs.includes("sound.wav") && hrefs.includes("sub/"));
    const base = new URL("/api/v1/owner-files/materials/demo/", s.api.baseUrl);
    const file = await s.get(new URL("sound.wav", base).pathname.replace("/api/v1/owner-files", ""));
    assert.equal(file.status, 200);
    const sub = await s.get(new URL("sub/", base).pathname.replace("/api/v1/owner-files", ""));
    assert.equal(sub.status, 200);
    assert.match(sub.body.toString(), /href="a\.wav"/u);

    const rootPage = await s.get("/shared/");
    assert.match(rootPage.body.toString(), /hello\.txt/u);
  });
}

test("requires the Owner's authentication on files, folders and roots", async (t) => {
  const s = await setup(t, { wrap: false });
  if (!s) return t.skip("localhost listen is unavailable");
  for (const path of ["/roots", "/materials/demo/note.md", "/materials/demo/"]) {
    const denied = await s.get(path, {});
    assert.equal(denied.status, 401, path);
    assert.ok(!denied.body.toString().includes("メモ"));
    assert.equal((await s.get(path)).status, 200, path);
  }
});
