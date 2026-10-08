import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { GUARD_COMMAND_KEYS, GUARD_NAMED_TOOLS, guardChecksToolCall, isReadOnlyAgentRole, readOnlyToolAllowed } from "../../../packages/shared/dist/guard-inputs.js";
import { GUARD_TOKEN_FILE_ENV } from "../../../packages/shared/dist/guard-token.js";
import { isResearchSubagentType, researchToolDecision } from "../../../packages/shared/dist/research-subagent.js";

interface HookInput {
  readonly hook_event_name?: unknown;
  readonly tool_name?: unknown;
  readonly tool_input?: unknown;
  readonly cwd?: unknown;
  /** Set by the CLI when a subagent makes the call; the model cannot change it. */
  readonly agent_type?: unknown;
}

interface GuardResponse {
  readonly data?: {
    readonly allowed?: unknown;
    readonly message?: unknown;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//iu;
/** Words that run the next command: wrappers (sudo, timeout) and shell keywords that can start a simple command ("then ..."). */
const COMMAND_WRAPPERS = new Set([
  "sudo", "env", "command", "time", "nohup", "exec", "nice", "builtin", "timeout", "xargs", "stdbuf",
  "{", "!", "if", "then", "elif", "else", "do", "while", "until",
]);
/** Options whose next argument is a value, not a destination. The short flags differ between curl and wget. */
const VALUE_OPTIONS: Record<"curl" | "wget", { short: string; long: Set<string> }> = {
  curl: {
    short: "AbcCdDeEFHKmoPQrTuUwxXyYzt",
    long: new Set([
      "--output", "--header", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--request", "--user-agent", "--referer", "--user", "--max-time",
      "--connect-timeout", "--url", "--preproxy", "--retry", "--retry-delay", "--retry-max-time", "--cookie", "--cookie-jar", "--form", "--upload-file", "--proxy", "--cacert", "--cert", "--key",
      "--write-out", "--config", "--range", "--output-dir", "--limit-rate", "--resolve", "--dump-header", "--continue-at", "--connect-to", "--interface", "--json",
    ]),
  },
  wget: {
    short: "oaOetTwQPUBiIXDRAlY",
    long: new Set([
      "--output-document", "--output-file", "--append-output", "--execute", "--tries", "--timeout", "--wait", "--quota", "--directory-prefix", "--user-agent",
      "--input-file", "--header", "--post-data", "--post-file", "--method", "--body-data", "--body-file", "--http-user", "--http-password", "--referer", "--proxy",
      "--bind-address", "--limit-rate", "--read-timeout", "--connect-timeout", "--dns-timeout", "--waitretry", "--user", "--password", "--accept", "--reject",
    ]),
  },
};

/** True when the option word takes its value from the next argument. */
function takesNextValue(word: string, tool: "curl" | "wget"): boolean {
  const { short, long } = VALUE_OPTIONS[tool];
  if (word.startsWith("--")) return long.has(word);
  for (let i = 1; i < word.length; i += 1) {
    if (short.includes(word[i])) return i === word.length - 1;
  }
  return false;
}

/** Splits a shell command into simple commands, each a list of unquoted words. Redirection targets are dropped. */
function shellSimpleCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: string | null = null;
  let skipNext = false;
  const endWord = (): void => {
    if (inWord) {
      if (skipNext) skipNext = false;
      else words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endCommand = (): void => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === "\"" && i + 1 < command.length) word += command[++i];
      else word += char;
    } else if (char === "'" || char === "\"") {
      quote = char;
      inWord = true;
    } else if (char === "\\" && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (/\s/u.test(char) && char !== "\n") endWord();
    else if (char === "\n" || char === ";" || char === "|" || char === "&" || char === "(" || char === ")") endCommand();
    else if (char === "`") {
      // Command substitution: keep a marker word so the enclosing curl/wget is denied, then split to scan the inner command.
      endWord();
      words.push("`");
      endCommand();
    }
    else if (char === ">" || char === "<") {
      endWord();
      if (command[i + 1] === char) i += 1;
      skipNext = true;
    } else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

const SHELLS = /^(?:ba|z|da|k)?sh$/u;
const PROXY_VARIABLES = new Set(["http_proxy", "https_proxy", "all_proxy"]);
const NETWORK_TOOL_MENTION = /\b(?:curl|wget)\b/u;

/** Splits an option word into its name and value; the value is null when it is the next word. */
function parseOption(word: string, tool: "curl" | "wget"): { name: string; value: string | null } {
  if (word.startsWith("--")) {
    const eq = word.indexOf("=");
    return eq < 0 ? { name: word, value: null } : { name: word.slice(0, eq), value: word.slice(eq + 1) };
  }
  const { short } = VALUE_OPTIONS[tool];
  for (let i = 1; i < word.length; i += 1) {
    if (short.includes(word[i])) return { name: `-${word[i]}`, value: i === word.length - 1 ? null : word.slice(i + 1) };
  }
  return { name: word, value: "" };
}

/**
 * Destination URLs of the curl and wget invocations in a shell command, including proxies and rerouted
 * connections. A scheme-less destination such as "curl 127.0.0.1" gets http://. Throws when a destination
 * cannot be determined (variable expansion, command substitution, option files), so the caller denies.
 */
function networkCommandUrls(command: string): string[] {
  const urls: string[] = [];
  const addUrl = (value: string): void => {
    if (/[$`]/u.test(value)) throw new Error("destination cannot be determined");
    if (value !== "") urls.push(URL_SCHEME.test(value) ? value : `http://${value}`);
  };
  for (const words of shellSimpleCommands(command)) {
    // A proxy assignment with a substitution splits from its command at the substitution, so its target is unknown.
    if (NETWORK_TOOL_MENTION.test(command) && words.some((w, i) => /^\w+=/u.test(w) && PROXY_VARIABLES.has(w.slice(0, w.indexOf("=")).toLowerCase()) && (/[$`]/u.test(w) || words[i + 1] === "`"))) {
      throw new Error("proxy destination cannot be determined");
    }
    let index = words.findIndex((w) => !/^\w+=/u.test(w) && !COMMAND_WRAPPERS.has(w));
    // Wrapper options such as "env -i" or "nice -n 5" hide the real program, so look for it past them.
    if (index > 0 && words.slice(0, index).some((w) => COMMAND_WRAPPERS.has(w))) {
      const real = words.findIndex((w, i) => i >= index && /^(?:curl|wget|eval|(?:ba|z|da|k)?sh)$/u.test(w.replace(/^.*\//u, "")));
      if (real >= 0) index = real;
    }
    const program = index < 0 ? "" : words[index].replace(/^.*\//u, "");
    const tool = program === "curl" || program === "wget" ? program : undefined;
    if (SHELLS.test(program) || program === "eval") {
      const rest = words.slice(index + 1);
      const script = program === "eval" ? rest.join(" ") : rest.slice(rest.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/u.test(w)) + 1).find((w) => w !== "--");
      if (typeof script === "string" && NETWORK_TOOL_MENTION.test(script)) {
        for (const w of words.slice(0, index)) {
          const assignment = /^(\w+)=(.*)$/u.exec(w);
          if (assignment && PROXY_VARIABLES.has(assignment[1].toLowerCase())) addUrl(assignment[2]);
        }
        urls.push(...networkCommandUrls(script));
      }
      continue;
    }
    if (!tool) continue;
    for (const w of words.slice(0, index)) {
      const assignment = /^(\w+)=(.*)$/u.exec(w);
      if (assignment && PROXY_VARIABLES.has(assignment[1].toLowerCase())) addUrl(assignment[2]);
    }
    for (index += 1; index < words.length; index += 1) {
      const word = words[index];
      if (!word.startsWith("-") || word === "-") {
        addUrl(word);
        continue;
      }
      const { name, value: inline } = parseOption(word, tool);
      const value = inline ?? (takesNextValue(word, tool) ? words[++index] ?? "" : "");
      if (name === "-K" || name === "--config" || name === "--input-file" || (tool === "wget" && name === "-i")) throw new Error("option file");
      if (name === "--url" || name === "--preproxy" || (tool === "curl" && (name === "-x" || name === "--proxy"))) addUrl(value);
      else if (name === "--connect-to") {
        const target = /^[^:]*:[^:]*:(\[[^\]]+\]|[^:]*)(?::[^:]*)?$/u.exec(value);
        if (!target) throw new Error("unparseable --connect-to");
        addUrl(target[1]);
      } else if (name === "--resolve") {
        const target = /^[+-]?[^:]*:[^:]*:(.+)$/u.exec(value);
        if (!target) throw new Error("unparseable --resolve");
        for (const address of target[1].split(",")) addUrl(address);
      } else if (tool === "wget" && (name === "-e" || name === "--execute")) {
        if (/[$`]/u.test(value)) throw new Error("wget setting cannot be determined");
        const setting = /^\s*(\w+)\s*=\s*(.*?)\s*$/u.exec(value);
        if (setting && /^(?:http|https|ftp)_proxy$/iu.test(setting[1])) addUrl(setting[2]);
      }
    }
  }
  return urls;
}

function outboundUrls(toolName: string, toolInput: Record<string, unknown>): string[] {
  const name = toolName.toLowerCase();
  if (name === "webfetch") return [typeof toolInput.url === "string" ? toolInput.url : ""];
  if (!GUARD_NAMED_TOOLS.has(name)) return [];
  const command = GUARD_COMMAND_KEYS.map((key) => toolInput[key]).find((value) => typeof value === "string");
  return typeof command === "string" ? networkCommandUrls(command) : [];
}

/** Returns a denial reason, or null when every destination is allowed. A guard that cannot run denies. */
async function checkOutbound(toolName: string, toolInput: Record<string, unknown>): Promise<string | null> {
  try {
    const urls = outboundUrls(toolName, toolInput);
    if (urls.length === 0) return null;
    const owlRoot = process.env.OWL_ROOT;
    if (!owlRoot || !isAbsolute(owlRoot)) throw new Error("OWL_ROOT is unavailable");
    const { OutboundGuard } = await import("../../../packages/core/dist/outbound-guard.js");
    const guard = new OutboundGuard(owlRoot);
    guard.load();
    for (const url of urls) {
      const result = await guard.checkUrlResolved(url);
      if (!result.allowed) return `Outbound request to ${url} was denied by the outbound guard (${result.rule}).`;
    }
    return null;
  } catch {
    return "Tool execution was denied because the outbound guard is unavailable.";
  }
}

function deny(reason: string): void {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  })}\n`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  let input: HookInput;
  try {
    const parsed: unknown = JSON.parse(await readStdin());
    if (!isRecord(parsed)) throw new Error("hook input is not an object");
    input = parsed as HookInput;
  } catch {
    deny("Tool execution was denied because the PreToolUse input could not be parsed.");
    return;
  }

  if (input.hook_event_name !== "PreToolUse") {
    deny("Only PreToolUse events are allowed.");
    return;
  }
  if (typeof input.tool_name !== "string" || input.tool_name.length === 0 || !isRecord(input.tool_input)) {
    deny("Tool execution was denied because the tool name or input could not be determined.");
    return;
  }
  if (isResearchSubagentType(input.agent_type) && researchToolDecision(input.agent_type, input.tool_name) === "deny") {
    deny("Owl の調べもの役は読み取り専用のため、このツールを使えない。使えるのは調べもの用のツールだけ。");
    return;
  }
  if (isReadOnlyAgentRole(process.env.OWL_AGENT_ROLE) && !readOnlyToolAllowed(input.tool_name)) {
    deny("読み取り専用の調査ではこのツールを使えない。");
    return;
  }
  const outboundDenial = await checkOutbound(input.tool_name, input.tool_input);
  if (outboundDenial) {
    deny(outboundDenial);
    return;
  }
  // A call with no path or command arguments has nothing the rules can
  // match, so it runs without asking the guard (MCP and web tools mostly).
  if (!guardChecksToolCall(input.tool_name, input.tool_input)) return;

  const role = process.env.OWL_AGENT_ROLE;
  const apiBase = process.env.OWL_GUARD_API_BASE;
  const tokenFile = process.env[GUARD_TOKEN_FILE_ENV];
  if (!role || !apiBase || !tokenFile || !isAbsolute(tokenFile)) {
    deny("Tool execution was denied because the Owl guard configuration is unavailable.");
    return;
  }
  let guardToken: string;
  try {
    guardToken = (await readFile(tokenFile, "utf8")).trim();
  } catch {
    guardToken = "";
  }
  if (guardToken.length === 0) {
    deny("Tool execution was denied because the Owl guard token could not be read.");
    return;
  }
  const cwd = typeof input.cwd === "string" && isAbsolute(input.cwd)
    ? input.cwd
    : process.env.OWL_AGENT_CWD;
  if (!cwd || !isAbsolute(cwd)) {
    deny("Tool execution was denied because the working directory could not be determined.");
    return;
  }

  const endpoint = `${apiBase.replace(/\/$/u, "")}/api/v1/guard/check`;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${guardToken}`,
      },
      body: JSON.stringify({
        request_id: randomUUID(),
        idempotency_key: randomUUID(),
        expected_version: 0,
        payload: {
          role,
          tool_name: input.tool_name,
          tool_input: input.tool_input,
          cwd,
        },
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      deny(`Tool execution was denied because Owl guard returned HTTP ${response.status}.`);
      return;
    }
    const body: unknown = await response.json();
    const result = isRecord(body) && isRecord(body.data) ? body.data as GuardResponse["data"] : undefined;
    if (result?.allowed === true) return;
    const message = typeof result?.message === "string" && result.message.length > 0
      ? result.message
      : "Tool execution was denied because Owl guard did not grant permission.";
    deny(message);
  } catch {
    deny("Tool execution was denied because Owl guard could not be reached.");
  }
}

void main().catch(() => {
  deny("Tool execution was denied because Owl guard could not make a decision.");
});
