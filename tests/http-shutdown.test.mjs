import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createOwlHttpServer } from "../apps/server/dist/http.js";

test("HTTP shutdown closes an unfinished client request promptly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "owl-http-shutdown-"));
  const http = createOwlHttpServer({
    core: { ready: true },
    webOut: root,
    bind: "127.0.0.1",
    port: 0,
    contract: { contract_version: "1.0.0" },
    owlRoot: root,
  });
  try {
    await http.listen();
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip("localhost listen is unavailable");
      return;
    }
    throw error;
  }

  const address = http.server.address();
  const client = createConnection({ host: "127.0.0.1", port: address.port });
  try {
    await once(client, "connect");
    client.write("POST /api/v1/health HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx");
    await new Promise((resolve) => setTimeout(resolve, 25));

    const closePromise = http.close();
    const closedPromptly = await Promise.race([
      closePromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    assert.equal(closedPromptly, true, "shutdown must not wait indefinitely for an unfinished request");
    await closePromise;
  } finally {
    client.destroy();
    if (http.server.listening) await http.close();
  }
});
