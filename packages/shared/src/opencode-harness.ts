import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  DESIGN_MOCK_MCP_SERVER_NAME,
  DISPATCH_MCP_SERVER_NAME,
  MEMORY_MCP_SERVER_NAME,
  OWL_API_MCP_SERVER_NAME,
  opencodeMcpConfig,
  type McpServerSpec,
} from "./owl-mcp-servers.js";
import type { AgentPermissionRole } from "./permission-args.js";
import { compareSemver, parseSemver } from "./semver.js";

/** opencode 1.x has a different API; only v2 is driven. */
export const OPENCODE_MIN_SUPPORTED_VERSION = "2.0.0";
/** Upper bound for `serve` to print its URL and pass the startup checks. */
export const OPENCODE_STARTUP_TIMEOUT_MS = 30_000;
/** serve sends a heartbeat every 15s; three missed ones mean the stream is gone. */
export const OPENCODE_EVENT_STALL_MS = 45_000;
/** Longest retry wait Owl sits through; retries are stopped by this and the wall timeout, never by a count. */
export const OPENCODE_RETRY_WAIT_LIMIT_MS = 60_000;
/** How long to wait for the tool-call details that belong to a permission request. */
export const OPENCODE_TOOL_LOOKUP_WAIT_MS = 2_000;

export const OPENCODE_EXECUTABLE_ENV = "OWL_OPENCODE_EXECUTABLE";
export const OPENCODE_BASE_URL_ENV = "OWL_OPENCODE_BASE_URL";
export const OPENCODE_API_KEY_ENV_ENV = "OWL_OPENCODE_API_KEY_ENV";

/** Variables from Owl's own environment that must not reach serve: only Owl's config may apply. */
const OPENCODE_SCRUBBED_ENV = [
  "OPENCODE_CONFIG",
  "OPENCODE_CLI_CONFIG_CONTENT",
  "OPENCODE_DISABLE_PROJECT_CONFIG",
  "OPENCODE_TEST_HOME",
  "OPENCODE_SERVER_PASSWORD",
] as const;

export interface OpencodePermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "ask" | "allow" | "deny";
}

/** First `x.y.z` in the text as [major, minor, patch]; null when there is none. */
export function parseOpencodeVersion(text: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when the text holds a version at or above OPENCODE_MIN_SUPPORTED_VERSION. */
export function isSupportedOpencodeVersion(text: string): boolean {
  const found = parseOpencodeVersion(text);
  const minimum = parseSemver(OPENCODE_MIN_SUPPORTED_VERSION);
  if (!found || !minimum) return false;
  const version = parseSemver(found.join("."));
  return version !== null && compareSemver(version, minimum) >= 0;
}

/** `providerID/modelID` split at the first slash; null when either side is empty. */
export function splitOpencodeModel(model: string): { providerID: string; modelID: string } | null {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export interface OpencodeServeEnvInput {
  /** Env the run already has (OWL_ROLE etc.); copied, then overlaid. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly password: string;
  /** Per-run directory; an empty 0700 `config` directory is created below it. */
  readonly runDir: string;
  readonly configContent: string;
}

/** Env for one `opencode serve`: nothing from the user's or repository's opencode setup is read. */
export function opencodeServeEnv(input: OpencodeServeEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) if (value !== undefined) env[key] = value;
  for (const name of OPENCODE_SCRUBBED_ENV) delete env[name];
  const configDir = join(input.runDir, "config");
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  chmodSync(configDir, 0o700);
  return {
    ...env,
    OPENCODE_PASSWORD: input.password,
    OPENCODE_CONFIG_DIR: configDir,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_CONFIG_CONTENT: input.configContent,
  };
}

/** AGENTS.md files from the git root down to cwd (cwd alone without a git root); only files that exist. */
function agentsFiles(cwd: string): string[] {
  const directories: string[] = [];
  let root: string | null = null;
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    directories.unshift(dir);
    if (existsSync(join(dir, ".git"))) {
      root = dir;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  const chain = root === null ? [resolve(cwd)] : directories;
  return chain.map((dir) => join(dir, "AGENTS.md")).filter((file) => existsSync(file));
}

export interface OpencodeConfigInput {
  readonly cwd: string;
  /** `providerID/modelID`; its provider receives the connection override. */
  readonly model: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly permissions: readonly OpencodePermissionRule[];
  readonly mcpServers: readonly McpServerSpec[];
  /** Files placed after the AGENTS.md chain (the Advisor system prompt). */
  readonly extraInstructions?: readonly string[];
}

/** Content of OPENCODE_CONFIG_CONTENT. Secrets appear only as `{env:NAME}` references. */
export function opencodeConfigContent(input: OpencodeConfigInput): string {
  const baseURL = input.env[OPENCODE_BASE_URL_ENV];
  const apiKeyEnv = input.env[OPENCODE_API_KEY_ENV_ENV];
  const settings = {
    ...(baseURL ? { baseURL } : {}),
    ...(apiKeyEnv ? { apiKey: `{env:${apiKeyEnv}}` } : {}),
  };
  const model = splitOpencodeModel(input.model);
  if (Object.keys(settings).length > 0 && !model) throw new Error(`opencode model must be providerID/modelID: ${input.model}`);
  return JSON.stringify({
    update: "disable",
    share: "disabled",
    snapshots: false,
    permissions: input.permissions,
    instructions: [...agentsFiles(input.cwd), ...(input.extraInstructions ?? [])],
    mcp: opencodeMcpConfig(input.mcpServers),
    ...(model && Object.keys(settings).length > 0 ? { providers: { [model.providerID]: { settings } } } : {}),
  });
}

const OWL_MCP_SERVER_NAMES = [MEMORY_MCP_SERVER_NAME, OWL_API_MCP_SERVER_NAME, DISPATCH_MCP_SERVER_NAME, DESIGN_MOCK_MCP_SERVER_NAME];

/**
 * Rules for the session and the config `permissions`. opencode lets the last matching rule win, so the
 * leading `* * ask` sends every operation to Owl's hook and the denies after it stay final.
 * The librarian's denies mirror Claude's --disallowedTools; the hook is the real limit.
 */
export function opencodePermissionRules(role: AgentPermissionRole): OpencodePermissionRule[] {
  const deny = (action: string): OpencodePermissionRule => ({ action, resource: "*", effect: "deny" });
  return [
    { action: "*", resource: "*", effect: "ask" },
    ...["question", "subagent", "skill", "execute"].map(deny),
    ...(role === "librarian" ? ["edit", "webfetch", "websearch"].map(deny) : []),
  ];
}

export interface OpencodeToolCall {
  readonly tool_name: string;
  readonly tool_input: Record<string, unknown>;
  readonly cwd: string;
  /** True for tools in the translation table and Owl's MCP servers; their success must follow a once reply. */
  readonly hooked: boolean;
}

const OPENCODE_TOOL_NAMES: Record<string, { name: string; keys: Record<string, string> }> = {
  read: { name: "Read", keys: { path: "file_path" } },
  write: { name: "Write", keys: { path: "file_path" } },
  edit: { name: "Edit", keys: { path: "file_path", oldString: "old_string", newString: "new_string", replaceAll: "replace_all" } },
  patch: { name: "apply_patch", keys: { patchText: "patch" } },
  shell: { name: "Bash", keys: {} },
  glob: { name: "Glob", keys: {} },
  grep: { name: "Grep", keys: {} },
  webfetch: { name: "WebFetch", keys: {} },
  websearch: { name: "WebSearch", keys: {} },
};

/** The name and input the PreToolUse hook reads for an opencode tool call; the original keys stay. */
export function normalizeOpencodeToolCall(name: string, input: Record<string, unknown>, cwd: string): OpencodeToolCall {
  const mapped = Object.hasOwn(OPENCODE_TOOL_NAMES, name) ? OPENCODE_TOOL_NAMES[name] : null;
  if (mapped) {
    const tool_input: Record<string, unknown> = { ...input };
    for (const [from, to] of Object.entries(mapped.keys)) if (from in input) tool_input[to] = input[from];
    const workdir = name === "shell" && typeof input.workdir === "string" && input.workdir.length > 0 ? input.workdir : cwd;
    return { tool_name: mapped.name, tool_input, cwd: workdir, hooked: true };
  }
  const server = OWL_MCP_SERVER_NAMES.find((candidate) => name.startsWith(`${candidate}_`));
  if (server) return { tool_name: `mcp__${server}__${name.slice(server.length + 1)}`, tool_input: { ...input }, cwd, hooked: true };
  return { tool_name: name, tool_input: { ...input }, cwd, hooked: false };
}
export interface OpencodeHarnessGap {
  readonly key: string;
  readonly ja: string;
  readonly en: string;
}

/** What Owl cannot hand to opencode, or hands over differently, compared with Claude and Codex. Reports and doctor read this one list. */
export const OPENCODE_HARNESS_GAPS: readonly OpencodeHarnessGap[] = [
  { key: "process_skills_tools_reference", ja: "Advisor の「Harness tool names」の行と process skills の参照ファイルの行は出しません。", en: "The Advisor's \"Harness tool names\" line and the process skills reference-file lines are not given." },
  { key: "process_skills_native", ja: "process skills の呼び出し方は常に `Read <path>.` の文面になります。", en: "Process skills are always invoked with the `Read <path>.` wording." },
  { key: "mcp_tool_names", ja: "MCP のツール名は opencode の決まりで `<server>_<tool>` の形になります。", en: "MCP tool names take opencode's `<server>_<tool>` form." },
  { key: "permission_instead_of_hook", ja: "PreToolUse hook の代わりに permission の応答で同じ hook を呼んで判定します。opencode が permission を出さずにツールを動かせば、判定を通りません。", en: "The same hook is called from permission replies instead of PreToolUse; a tool opencode runs without asking for permission skips the check." },
  { key: "child_write_paths", ja: "子 Executor の write_paths は指示文で守らせます。opencode の子では Owl の hook の判定が permission の応答を通してしか行われないため、write_paths の外への書き込みを止める安全網が Claude・Codex の子より弱くなります。", en: "A child Executor keeps to its write_paths because its instructions say so. For an opencode child, Owl's hook judges tool use only through permission replies, so the safety net against writes outside write_paths is weaker than for Claude and Codex children." },
  { key: "research_capture", ja: "PostToolUse の research capture は行いません。", en: "PostToolUse research capture is not performed." },
  { key: "token_relay", ja: "PreCompact と token relay は行いません。", en: "PreCompact and the token relay are not performed." },
  { key: "subagent_hooks", ja: "SubagentStart/Stop の hook は行いません。", en: "SubagentStart/Stop hooks are not performed." },
  { key: "research_subagent", ja: "研究用サブエージェントは使いません。", en: "The research subagent is not used." },
  { key: "user_opencode_config", ja: "利用者が opencode の全体の設定に入れた MCP サーバー・provider・スキル・エージェント・プラグインは使えません。", en: "MCP servers, providers, skills, agents and plugins in the user's global opencode config are not available." },
  { key: "plan_usage", ja: "プランの使用量は取れません。", en: "Plan usage cannot be read." },
  { key: "effort_variant", ja: "effort は session の model の variant として渡します。モデルがその variant を持たないときは渡しません。", en: "Effort is passed as the session model's variant, and omitted when the model has no such variant." },
  { key: "structured_output", ja: "報告の構造化出力のスキーマは渡さず、Owl の出力テンプレートと検証で受けます。", en: "The structured-output schema is not passed; Owl's output template and validation receive the report." },
  { key: "system_prompt_channel", ja: "Advisor のシステムプロンプトは指示ファイルとして渡し、前に `Instructions from: <path>` が付きます。", en: "The Advisor system prompt is passed as an instruction file prefixed with `Instructions from: <path>`." },
  { key: "unremovable_config", ja: "system・managed・wellknown の設定と `~/.agents` は止められません。", en: "System, managed and wellknown config and `~/.agents` cannot be switched off." },
  { key: "denied_opencode_tools", ja: "opencode の `subagent`・`skill`・`question`・`execute` は使わせません。", en: "opencode's `subagent`, `skill`, `question` and `execute` tools are denied." },
  { key: "repo_project_config", ja: "リポジトリの `opencode.json` と `.opencode/` は読ませません。`AGENTS.md` は Owl が `instructions` で渡します。", en: "The repository's `opencode.json` and `.opencode/` are not read; Owl passes `AGENTS.md` through `instructions`." },
  { key: "decision_order", ja: "permission の判定の順序は実行ファイルの内部の決まりによるため、版が上がると変わることがあります。", en: "The permission decision order is internal to the opencode executable and may change with its version." },
  { key: "saved_permissions", ja: "利用者が opencode で「常に許可」を選ぶと、Owl のルールの後ろに allow が足されます。保存された許可があるプロジェクトでは実行しません。", en: "An \"always allow\" chosen in opencode adds an allow after Owl's rules; runs are refused in projects with saved permissions." },
  { key: "nested_opencode", ja: "agent の shell が別の opencode を動かすと、その中の操作は Owl の判定を通りません（shell の command だけが判定されます）。", en: "Operations inside another opencode started from the agent's shell skip Owl's check; only the shell command is judged." },
];
