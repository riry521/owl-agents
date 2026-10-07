import { createOwlHttpServer } from "../../apps/server/dist/http.js";

/**
 * Start an Owl HTTP server on 127.0.0.1:0. Returns null when listening is not permitted
 * (caller: `if (!api) return t.skip("localhost listen is unavailable")`); other errors throw.
 * With token, OWL_API_TOKEN is set for the test and restored in t.after.
 * @param {import("node:test").TestContext} t
 * @param {object} serverOptions passed to createOwlHttpServer
 * @param {{ token?: string }} [options]
 */
export async function startTestHttpServer(t, serverOptions, { token } = {}) {
  const http = createOwlHttpServer({ bind: "127.0.0.1", port: 0, contract: { contract_version: "1.0.0" }, ...serverOptions });
  const hadToken = Object.hasOwn(process.env, "OWL_API_TOKEN");
  const previousToken = process.env.OWL_API_TOKEN;
  if (token !== undefined) process.env.OWL_API_TOKEN = token;
  const restoreToken = () => {
    if (token === undefined) return;
    if (hadToken) process.env.OWL_API_TOKEN = previousToken;
    else delete process.env.OWL_API_TOKEN;
  };
  try {
    await http.listen();
  } catch (error) {
    restoreToken();
    if (error?.code === "EPERM" || error?.code === "EACCES") return null;
    throw error;
  }
  t.after(async () => {
    try {
      await http.close();
    } finally {
      restoreToken();
    }
  });
  const baseUrl = `http://127.0.0.1:${http.server.address().port}`;
  const request = (method, route, body) => {
    const headers = {};
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  return { http, baseUrl, request };
}
