import { cp, mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { tempDir } from "./temp.mjs";

/**
 * A copy of the server build next to an agent runtime whose runner lacks the named methods, as an older runtime would be.
 * With delegate, the runtime's runner is that scripted object (minus the named methods) instead of the real one.
 * Returns the copied agent-runner module; call its createExternalAgentRunner under the provider environment.
 */
export async function serverRunnerModuleWithout(t, methods, delegate) {
  const tree = await tempDir(t, "owl-agent-runner-old-runtime-");
  const serverDist = path.join(tree, "apps/server/dist");
  await mkdir(path.join(tree, "packages/agent-runtime/dist"), { recursive: true });
  await cp(new URL("../../apps/server/dist", import.meta.url), serverDist, { recursive: true });
  for (const name of ["shared", "core", "db"]) {
    await symlink(fileURLToPath(new URL(`../../packages/${name}`, import.meta.url)), path.join(tree, "packages", name));
  }
  globalThis.__owlScriptedRuntimeRunner = delegate;
  const realRuntime = JSON.stringify(new URL("../../packages/agent-runtime/dist/index.js", import.meta.url).href);
  await writeFile(
    path.join(tree, "packages/agent-runtime/dist/index.js"),
    `import { createAgentRunner as create } from ${realRuntime};\nexport * from ${realRuntime};\nexport const createAgentRunner = (options) => {\n  const { ${["_", ...methods].join(", ")}, ...rest } = globalThis.__owlScriptedRuntimeRunner ?? create(options);\n  return rest;\n};\n`,
    "utf8",
  );
  await writeFile(path.join(tree, "packages/agent-runtime/package.json"), "{\"type\":\"module\"}\n", "utf8");
  await writeFile(path.join(tree, "apps/server/package.json"), "{\"type\":\"module\"}\n", "utf8");
  return import(pathToFileURL(path.join(serverDist, "agent-runner.js")).href);
}
