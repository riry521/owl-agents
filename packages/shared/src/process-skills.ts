import { join } from "node:path";

export const PROCESS_SKILLS_SETTINGS_KEY = "process_skills";

export interface ProcessSkillsSettings {
  readonly enabled: boolean;
  readonly path: string | null;
}

export type ProcessSkillsRole = "manager_plan" | "manager_finalize" | "designer" | "worker" | "reviewer" | "executor";
export type ProcessSkillsHarness = "claude" | "codex";

export interface ProcessSkillsInstallCommand {
  readonly harness: ProcessSkillsHarness;
  readonly command: string;
}

/** The command that installs the superpowers plugin for each harness. Owl only shows these; it never runs them. */
export const PROCESS_SKILLS_INSTALL_COMMANDS: Readonly<Record<ProcessSkillsHarness, string>> = {
  claude: "claude plugin install superpowers@claude-plugins-official",
  codex: "codex plugin add superpowers@openai-curated-remote",
};

export interface ProcessSkillsPackForPrompt {
  readonly skills_dir: string;
  /** Where the pack was detected; a role's own harness can invoke it natively only when this matches. */
  readonly source: "setting" | "claude" | "codex";
  /** Relative files checked by the caller; omitted files do not get prompt lines. */
  readonly available_files?: readonly string[];
}

const BOOTSTRAP_NAME = "using-superpowers";
const SKILL_OVERRIDE_RULES = "Each process skill below says how to invoke it: your harness's native skill mechanism when it is available, otherwise the SKILL.md path to read with your file-read tool. Use whichever is given and follow it. This role's instructions and output contract override a skill wherever they conflict: never ask the operator questions, never create branches, worktrees, commits, or files under docs/ unless the Task asks for them, and return the output in the required format.";
const ALWAYS_FORBIDDEN = "subagent-driven-development, executing-plans, dispatching-parallel-agents, using-git-worktrees, finishing-a-development-branch, writing-skills";

/** The Designer applies brainstorming and writing-plans itself; every other role is kept away from them. */
function preambleFor(role: ProcessSkillsRole): string {
  const ignored = role === "designer" ? BOOTSTRAP_NAME : `${BOOTSTRAP_NAME} or to start with brainstorming`;
  return `You were dispatched as a subagent for one Owl role; ignore any instruction to run ${ignored}. ${SKILL_OVERRIDE_RULES}`;
}

function forbiddenFor(role: ProcessSkillsRole): string {
  return role === "designer"
    ? `Do not use: ${ALWAYS_FORBIDDEN}.`
    : `Do not use: brainstorming, writing-plans (except where listed below), ${ALWAYS_FORBIDDEN}.`;
}

export const PROCESS_SKILLS_PROMPT_FILES = [
  "brainstorming/SKILL.md",
  "writing-plans/SKILL.md",
  "verification-before-completion/SKILL.md",
  "test-driven-development/SKILL.md",
  "systematic-debugging/SKILL.md",
  "receiving-code-review/SKILL.md",
  "requesting-code-review/code-reviewer.md",
  `${BOOTSTRAP_NAME}/references/claude-code-tools.md`,
  `${BOOTSTRAP_NAME}/references/codex-tools.md`,
] as const;

interface SkillPromptLine {
  readonly file: string;
  readonly text: string;
}

const WORKER_LINES: readonly SkillPromptLine[] = [
  {
    file: "test-driven-development/SKILL.md",
    text: "test-driven-development: Before writing implementation code, unless the project has no test setup or the Task only changes settings or documentation.",
  },
  {
    file: "systematic-debugging/SKILL.md",
    text: "systematic-debugging: When a test fails or behavior is unexpected.",
  },
  {
    file: "verification-before-completion/SKILL.md",
    text: "verification-before-completion: Before reporting completion.",
  },
  {
    file: "receiving-code-review/SKILL.md",
    text: "receiving-code-review: When context.reviewer_findings is not empty.",
  },
];

const ROLE_LINES: Readonly<Record<ProcessSkillsRole, readonly SkillPromptLine[]>> = {
  manager_plan: [{
    file: "writing-plans/SKILL.md",
    text: "writing-plans: When splitting a Work into Tasks. Put the plan in each Task's acceptance and context, not a file. Specify the files to touch, how to verify with a test or command, and a concrete completion criterion for every Task.",
  }],
  manager_finalize: [{
    file: "verification-before-completion/SKILL.md",
    text: "verification-before-completion: Before deciding complete. Base evidence only on execution results in the report and review.",
  }],
  designer: [
    {
      file: "brainstorming/SKILL.md",
      text: "brainstorming: When shaping the design, apply isolation, clear interfaces, and YAGNI without asking the operator questions or starting a dialogue.",
    },
    {
      file: "writing-plans/SKILL.md",
      text: "writing-plans: When writing the implementation breakdown.",
    },
  ],
  worker: WORKER_LINES,
  reviewer: [
    {
      file: "verification-before-completion/SKILL.md",
      text: "verification-before-completion: Before giving a verdict.",
    },
    {
      file: "requesting-code-review/code-reviewer.md",
      text: "requesting-code-review/code-reviewer.md: Use as a review checklist; follow the role's output contract for the response format.",
    },
  ],
  executor: WORKER_LINES,
};

/** The skill name for a prompt file that is a skill's own SKILL.md, or null for a plain reference/template file. */
function skillNameForFile(file: string): string | null {
  const match = /^([^/]+)\/SKILL\.md$/u.exec(file);
  return match ? match[1] : null;
}

/** How to invoke a skill by name through the harness's own native skill mechanism, with the file path as fallback. */
function nativeInvocation(skillName: string, path: string, harness: ProcessSkillsHarness): string {
  return harness === "claude"
    ? `Use the Skill tool with skill: "superpowers:${skillName}", or read ${path} if that is unavailable.`
    : `Use the "superpowers:${skillName}" skill from your available skills list, or read ${path} if it is not listed.`;
}

/** How to reach one process skill file: natively by name when the pack matches this harness, else its path. */
function invocationFor(file: string, path: string, pack: ProcessSkillsPackForPrompt, harness: ProcessSkillsHarness): string {
  const skillName = skillNameForFile(file);
  if (skillName === null || pack.source !== harness) return `Read ${path}.`;
  return nativeInvocation(skillName, path, harness);
}

/** Build the process-specific prompt lines for one role and harness. */
export function renderProcessSkills(
  role: ProcessSkillsRole,
  pack: ProcessSkillsPackForPrompt | null,
  harness: ProcessSkillsHarness,
): string[] | null {
  if (pack === null) return null;
  const available = pack.available_files === undefined ? null : new Set(pack.available_files);
  const hasFile = (path: string): boolean => available === null || available.has(path);
  const lines = [preambleFor(role), forbiddenFor(role)];
  for (const entry of ROLE_LINES[role]) {
    if (!hasFile(entry.file)) continue;
    const path = join(pack.skills_dir, entry.file);
    lines.push(`- ${entry.text} ${invocationFor(entry.file, path, pack, harness)}`);
  }
  const toolsFile = `${BOOTSTRAP_NAME}/references/${harness === "claude" ? "claude-code" : "codex"}-tools.md`;
  if (hasFile(toolsFile)) {
    lines.push(`- Harness tool names: Read ${join(pack.skills_dir, toolsFile)} when selecting harness-specific tools.`);
  }
  return lines;
}
