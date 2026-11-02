import { readFileSync } from "node:fs";

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/github/${name}.json`, import.meta.url), "utf8"));

/** An Issue as the GitHub REST API returns it; `overrides` replace top-level keys. */
export const rawIssue = (overrides = {}) => ({ ...fixture("issue"), ...overrides });
export const rawPullRequest = (overrides = {}) => ({ ...fixture("pull-request"), ...overrides });
export const rawComment = (overrides = {}) => ({ ...fixture("issue-comment"), ...overrides });

export const label = (name) => ({ id: 1, name, color: "ededed", default: false });
export const user = (login, type = "User") => ({ login, id: 1, type, site_admin: false });

/**
 * A GhRunner standing in for `gh`, with a small in-memory repository.
 * Lists are filtered by `since` and paged like the real API; every call is recorded in `calls` (args and stdin).
 * `fail` / `truncate` map a list ("issues" | "comments" | "user" | "issue" | "pr_list" | "comment") to the number of
 * upcoming calls to that list that should fail or come back cut; `truncatePage` limits a cut to one page number.
 */
export function createFakeGh({ repo = "octocat/Hello-World", login = "octocat" } = {}) {
  const state = {
    repo, login, loginType: "User",
    issues: [], comments: [], prs: [],
    fail: {}, truncate: {}, truncatePage: {},
    calls: [],
    posted: [],
  };
  const consume = (table, key) => {
    if ((table[key] ?? 0) <= 0) return false;
    table[key] -= 1;
    return true;
  };
  const ok = (body, extra = {}) => ({ exit_code: 0, stdout: typeof body === "string" ? body : JSON.stringify(body), stderr: "", timed_out: false, stdout_truncated: false, ...extra });
  const page = (items, query) => {
    const since = query.get("since");
    const perPage = Number(query.get("per_page") ?? 30);
    const number = Number(query.get("page") ?? 1);
    const kept = items.filter((item) => since === null || Date.parse(item.updated_at) >= Date.parse(since));
    return kept.slice((number - 1) * perPage, number * perPage);
  };
  const list = (key, items, query) => {
    if (consume(state.fail, key)) return { exit_code: 1, stdout: "", stderr: "HTTP 502", timed_out: false, stdout_truncated: false };
    const onlyPage = state.truncatePage[key];
    if ((onlyPage === undefined || onlyPage === Number(query.get("page") ?? 1)) && consume(state.truncate, key)) return ok(JSON.stringify(page(items, query)).slice(0, 20), { stdout_truncated: true });
    return ok(page(items, query));
  };

  const runner = async (args, options) => {
    state.calls.push({ args: [...args], stdin: options?.stdin ?? null, options });
    const [command, second] = args;
    if (command === "api") {
      const [path, queryText = ""] = second.split("?");
      const query = new URLSearchParams(queryText);
      if (path === "user") {
        if (consume(state.fail, "user")) return { exit_code: 4, stdout: "", stderr: "gh: To get started with GitHub CLI, please run: gh auth login", timed_out: false, stdout_truncated: false };
        return ok(user(state.login, state.loginType));
      }
      if (path === `repos/${state.repo}/issues`) return list("issues", state.issues, query);
      if (path === `repos/${state.repo}/issues/comments`) return list("comments", state.comments, query);
      const single = /^repos\/[^/]+\/[^/]+\/issues\/(\d+)$/u.exec(path);
      if (single) {
        if (consume(state.fail, "issue")) return { exit_code: 1, stdout: "", stderr: "HTTP 404", timed_out: false, stdout_truncated: false };
        const found = [...state.issues].find((issue) => issue.number === Number(single[1]));
        return found ? ok(found) : { exit_code: 1, stdout: "", stderr: "HTTP 404", timed_out: false, stdout_truncated: false };
      }
    }
    if (command === "issue" && second === "comment") {
      if (consume(state.fail, "comment")) return { exit_code: 1, stdout: "", stderr: "HTTP 403", timed_out: false, stdout_truncated: false };
      const number = Number(args[2]);
      state.posted.push({ number, repo: args[args.indexOf("--repo") + 1], body: options?.stdin ?? "" });
      return ok(`https://github.com/${state.repo}/issues/${number}#issuecomment-${200 + state.posted.length}\n`);
    }
    if (command === "pr" && second === "list") {
      if (consume(state.fail, "pr_list")) return { exit_code: 1, stdout: "", stderr: "HTTP 502", timed_out: false, stdout_truncated: false };
      const head = args[args.indexOf("--head") + 1];
      return ok(state.prs.filter((pr) => pr.head === head).map(({ number, url }) => ({ number, url })));
    }
    return { exit_code: 1, stdout: "", stderr: `fake gh: unexpected ${args.join(" ")}`, timed_out: false, stdout_truncated: false };
  };
  runner.state = state;
  /** The `since` of each call to a list, in order. */
  runner.sinceOf = (list) => state.calls
    .filter((call) => call.args[0] === "api" && call.args[1].startsWith(list === "issues" ? `repos/${state.repo}/issues?` : `repos/${state.repo}/issues/comments?`))
    .map((call) => new URLSearchParams(call.args[1].split("?")[1]).get("since"));
  return runner;
}
