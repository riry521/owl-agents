/**
 * Owl's read-only researcher subagent: its definition for a Worker launch, the
 * Worker prompt reference, and the tool decision the permission hook enforces.
 * The hook loads this file from dist directly, so it imports nothing that needs Owl's runtime setup.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResearcherPromptRef } from "./agent-rules.js";
import { tomlString } from "./permission-args.js";
import type { ResearchSubagentSettings } from "./child-runs.js";

export type ResearchSubagentAdapter = "claude" | "codex";

/** Protocol names: the Worker prompt, the launch argv, and the permission hook must agree on them. */
export const RESEARCH_SUBAGENT_NAMES = { claude: "owl-researcher", codex: "owl_researcher" } as const;

/** The only tools the researcher may call. No shell: command contents cannot be judged read-only. */
export const RESEARCH_SUBAGENT_TOOLS = {
  // Haiku loads WebSearch through ToolSearch before its first search.
  claude: ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "ToolSearch"],
  // In code mode a Codex child searches through the exec tool's web.run, which reaches the hook as webrun.
  codex: ["web_search", "webrun"],
} as const;

export const RESEARCH_SUBAGENT_CLAUDE_DISALLOWED_TOOLS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task"] as const;

/**
 * Adapters whose read-only enforcement has been confirmed on a real child: Owl never enables a
 * researcher whose read-only limit it cannot enforce. Codex was confirmed on codex-cli 0.159.2,
 * where the child's shell, apply_patch, and spawn_agent calls reached Owl's PreToolUse hook with
 * agent_type owl_researcher and were denied; recheck when the CLI changes how child tools reach hooks.
 */
export const RESEARCH_SUBAGENT_ENABLED_ADAPTERS: ReadonlySet<ResearchSubagentAdapter> = new Set<ResearchSubagentAdapter>(["claude", "codex"]);

// Keyed by agent type, not one shared set: a Codex child must not get Claude-only tools such as Read.
const RESEARCH_TOOLS_BY_TYPE: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  (Object.keys(RESEARCH_SUBAGENT_NAMES) as ResearchSubagentAdapter[]).map((adapter) => [
    RESEARCH_SUBAGENT_NAMES[adapter],
    new Set(RESEARCH_SUBAGENT_TOOLS[adapter].map((tool) => tool.toLowerCase())),
  ]),
);

const PROMPT_REFS: Readonly<Record<ResearchSubagentAdapter, ResearcherPromptRef>> = {
  claude: { reference: "the `owl-researcher` agent in Claude's Agent tool", scope: "web or codebase research" },
  codex: { reference: "the `owl_researcher` agent role in Codex's multi-agent tools", scope: "web research" },
};

export function researchSubagentDescription(adapter: ResearchSubagentAdapter): string {
  return adapter === "claude"
    ? "Read-only researcher for web and codebase questions. Returns a short conclusion with sources. Cannot edit files or run commands."
    : "Read-only web researcher. Returns a short conclusion with sources. Cannot read local files, edit files, or run commands.";
}

export function researchSubagentInstructions(adapter: ResearchSubagentAdapter, settings: ResearchSubagentSettings): string {
  const tools = adapter === "claude" ? "WebSearch, WebFetch, Read, Grep, and Glob (load them with ToolSearch when needed)" : "web search";
  return [
    "You are Owl's read-only researcher. Answer only the research question you are given.",
    `Use only these tools: ${tools}. You have no shell: never try to run commands. Never create, edit, move, or delete files, never start other agents, and never commit, push, or install anything. Owl denies every other tool. Do not read .env files, secrets.json, or files under ~/.ssh, ~/.aws, or ~/.config/gh.`,
    `Stop within ${settings[adapter].max_turns} turns, even if the answer is incomplete.`,
    `Reply with only a short conclusion of at most ${settings.answer_max_chars} characters: the answer, the key evidence as file paths or URLs, and what remains uncertain. Do not paste long excerpts, raw tool output, or full files.`,
  ].join("\n");
}

/** How the Worker prompt names the researcher, or null when this adapter has none. */
export function researchSubagentPromptRef(adapter: ResearchSubagentAdapter): ResearcherPromptRef | null {
  return RESEARCH_SUBAGENT_ENABLED_ADAPTERS.has(adapter) ? PROMPT_REFS[adapter] : null;
}

/**
 * Builds the researcher definition argv without checking RESEARCH_SUBAGENT_ENABLED_ADAPTERS.
 * Worker launches must use buildResearchSubagentArgs: calling this directly would hand the
 * researcher to an adapter whose read-only enforcement has not been confirmed.
 */
export function researchSubagentDefinitionArgs(adapter: ResearchSubagentAdapter, settings: ResearchSubagentSettings): string[] {
  if (adapter === "codex") return codexResearcherArgs(settings);
  return ["--agents", JSON.stringify({
    [RESEARCH_SUBAGENT_NAMES.claude]: {
      description: researchSubagentDescription("claude"),
      prompt: researchSubagentInstructions("claude", settings),
      model: settings.claude.model,
      tools: RESEARCH_SUBAGENT_TOOLS.claude,
      disallowedTools: RESEARCH_SUBAGENT_CLAUDE_DISALLOWED_TOOLS,
      maxTurns: settings.claude.max_turns,
    },
  })];
}

/**
 * Codex reads a role from a config file. sandbox_mode is declarative only: the child inherits the
 * parent's sandbox, so Owl's PreToolUse hook (inherited from the parent) is what enforces read-only.
 * The role file carries no hooks for that reason.
 */
function codexResearcherArgs(settings: ResearchSubagentSettings): string[] {
  const content = [
    `model = ${tomlString(settings.codex.model)}`,
    `sandbox_mode = ${tomlString("read-only")}`,
    `developer_instructions = ${tomlString(researchSubagentInstructions("codex", settings))}`,
    "",
  ].join("\n");
  const path = join(tmpdir(), `owl-researcher-${createHash("sha256").update(content).digest("hex").slice(0, 16)}.toml`);
  writeFileSync(path, content, { mode: 0o600 });
  return [
    "--config", `agents.${RESEARCH_SUBAGENT_NAMES.codex}.description=${tomlString(researchSubagentDescription("codex"))}`,
    "--config", `agents.${RESEARCH_SUBAGENT_NAMES.codex}.config_file=${tomlString(path)}`,
  ];
}

/** The only entry point for Worker launches: [] unless the adapter is enabled. */
export function buildResearchSubagentArgs(adapter: ResearchSubagentAdapter, settings: ResearchSubagentSettings): string[] {
  return RESEARCH_SUBAGENT_ENABLED_ADAPTERS.has(adapter) ? researchSubagentDefinitionArgs(adapter, settings) : [];
}

/** Loose runtime parse of the settings Core puts in the Worker context; null when the shape is wrong. */
export function parseResearchSubagentSettings(value: unknown): ResearchSubagentSettings | null {
  if (!isRecord(value) || !isChoice(value.claude) || !isChoice(value.codex) || !isCount(value.answer_max_chars)) return null;
  return {
    claude: { model: value.claude.model, max_turns: value.claude.max_turns },
    codex: { model: value.codex.model, max_turns: value.codex.max_turns },
    answer_max_chars: value.answer_max_chars,
  };
}

export function isResearchSubagentType(agentType: unknown): boolean {
  return typeof agentType === "string" && RESEARCH_TOOLS_BY_TYPE.has(agentType);
}

/** Tool names only, never arguments: every tool outside that researcher type's allowlist is denied. */
export function researchToolDecision(agentType: unknown, toolName: string): "allow" | "deny" {
  const tools = typeof agentType === "string" ? RESEARCH_TOOLS_BY_TYPE.get(agentType) : undefined;
  return tools?.has(toolName.toLowerCase()) ? "allow" : "deny";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isChoice(value: unknown): value is { model: string; max_turns: number } {
  return isRecord(value) && typeof value.model === "string" && value.model.length > 0 && isCount(value.max_turns);
}
