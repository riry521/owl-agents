import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectInvestigationPrompt } from "../../packages/agent-runtime/dist/index.js";

test("the prompt only advertises the librarian's allowed Bash commands", () => {
  const prompt = buildProjectInvestigationPrompt({
    project: { id: "p1", name: "demo", base_branch: "main", commit: null },
    repo_path: "/tmp/repo",
    known_facts: { tech: [], commands: [], structure: [], cautions: [] },
    recent_works: [],
  });
  assert.ok(prompt.includes("Read tool to read files"));
  assert.ok(prompt.includes("Glob tool to list file names"));
  assert.ok(prompt.includes("Grep tool to search a single file"));
  const advertised = prompt.slice(prompt.indexOf("Bash is limited to"), prompt.indexOf("Prohibited: opening secret files"));
  assert.match(advertised, /cat \(no options\)/);
  assert.match(advertised, /head and tail \(-n <number> or -<number> only\)/);
  assert.match(advertised, /wc \(-l -c -w -m only\)/);
  assert.match(advertised, /ls \(-l -a -1 -h -R[^)]*\)/);
  assert.match(advertised, /pwd/);
  assert.match(advertised, /read-only git commands \(git log, git show, git diff, git ls-files, git status\)/);
  assert.match(advertised, /options?[^.]*allowlist/i);
  assert.match(advertised, /Shell expansion and control characters \(\* \? \[ \] \{ \} \$ ` ~ ; \| & < > \( \) and newlines\)/);
  assert.match(advertised, /do not use environment-variable assignments/);
  assert.doesNotMatch(advertised, /\b(grep|egrep|fgrep|rg|jq|find|sed|nl|file|stat|tree|du|echo|sort|uniq|cut|tr)\b/);
});
