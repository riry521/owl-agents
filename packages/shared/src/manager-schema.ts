import { ACCEPTANCE_CRITERION_ID_PREFIX, CRITERION_KINDS, CRITERION_ORIGIN_KINDS, CRITERION_ORIGIN_QUOTE_MAX, CRITERION_ORIGIN_SOURCES, CRITERION_REQUIREMENTS } from "./acceptance-criteria.js";
import { CHECK_WEIGHTS } from "./task-necessity.js";
import { KNOWLEDGE_EXTERNAL_COMMAND_RULE } from "./agent-rules.js";
import { objectSchema, SKILLS_USED_SCHEMA, SKILL_PROPOSALS_SCHEMA, type RoleSchema } from "./role-schema.js";

/** The Manager output schemas. They live in shared so the Owner-facing text check can read their field names. */
const TASK_TYPE_VALUES = ["research", "design", "code", "config", "doc", "test"] as const;

/** A field the model should write but an older answer may lack: absent means the criterion has no origin (treated as the Owner's). */
function withOptional(field: string, schema: RoleSchema): RoleSchema {
  return { ...schema, required: (schema.required ?? []).filter((name) => name !== field) };
}

/** The one definition of a Manager plan/replan Task. */
const MANAGER_TASK_SCHEMA: RoleSchema = objectSchema({
  id: { type: "string", minLength: 1, description: "Task id such as T1" },
  title: { type: "string", minLength: 1, description: "short Task title" },
  type: { type: "string", enum: TASK_TYPE_VALUES, description: "kind of work" },
  acceptance_criteria: {
    type: "array",
    minItems: 1,
    description: `the checkable success criteria the Worker must meet, one object per criterion; ids are ${ACCEPTANCE_CRITERION_ID_PREFIX}1, ${ACCEPTANCE_CRITERION_ID_PREFIX}2, ... in array order; a criterion over every occurrence names its concrete scope; written as deliverable behavior and checks to run, never as report-format requirements`,
    items: withOptional("requirement", withOptional("origin", objectSchema({
      id: { type: "string", minLength: 1, description: `${ACCEPTANCE_CRITERION_ID_PREFIX}<position>, e.g. ${ACCEPTANCE_CRITERION_ID_PREFIX}1` },
      text: { type: "string", minLength: 1, description: "what must be true (the content of the criterion)" },
      check: { type: "string", minLength: 1, description: "how to check it: a command, test or evidence that can run inside this Task" },
      serves: { type: "string", minLength: 1, description: "the part of the request this criterion serves" },
      if_omitted: { type: "string", minLength: 1, description: "what goes wrong for the request without this criterion" },
      check_weight: { type: "string", enum: CHECK_WEIGHTS, description: "light: reading files, unit tests, typecheck, building the touched package; medium: the full test suite, an integration run or a local server or browser on temporary data; heavy: real model or paid API calls, production-size data or copies of it, every item of a large set, or runs of about ten minutes or more" },
      kind: { type: "string", enum: CRITERION_KINDS, description: "spec_test: asks to add or change a test that pins the specification; work_check: anything else (confirming the work is right)" },
      weight_reason: { type: "string", description: "for heavy only: why no lighter check can prove what the request needs; empty string otherwise" },
      requirement: { type: "string", enum: CRITERION_REQUIREMENTS, description: "required: the Task is not done without it; keep these few. goal: wanted but not required; when it is not met the Worker reports why and the Task still completes. Make a criterion that depends on anything outside the Task, and a count or procedure criterion, goal" },
      origin: objectSchema({
        kind: { type: "string", enum: CRITERION_ORIGIN_KINDS, description: "owner: the criterion restates something the Owner wrote in the Work summary, an instruction or a Decision answer; manager: you added it yourself" },
        source: { type: ["string", "null"], enum: [...CRITERION_ORIGIN_SOURCES, null], description: "owner only: where the Owner wrote it (summary, instruction or decision_answer); null for manager" },
        quote: { type: "string", description: `owner only: the Owner's own sentence copied word for word (at most ${CRITERION_ORIGIN_QUOTE_MAX} characters); empty string for manager` },
      }),
    }))),
  },
  depends_on: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description: "ids of Tasks that must complete first; [] if none",
  },
  context: { type: "string", description: "background the Worker needs; empty string if none" },
  notes: { type: "string", description: "extra notes for the Worker; empty string if none" },
  review: {
    type: ["boolean", "null"],
    description: "true requires the Reviewer, false skips the Reviewer, null keeps the Work default",
  },
  required_sections: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description: "for a doc Task: headings the deliverable must contain (at most 20), checked by Core; [] if none",
  },
  required_tests: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description: "for a test Task: worktree-relative test files Core must run and see pass (at most 20); [] if none",
  },
  assigned_designer: {
    type: ["string", "null"],
    enum: ["designer", "lead_designer", null],
    description: "design Tasks only: lead_designer for the screen design (the look, layout and HTML mocks of screens) that the Work's request leaves to the Lead Designer; designer for any other design Task; null for Tasks that are not design Tasks. In a replan, null on a retried design Task keeps its current value; on a retried Task that becomes a design Task, null leaves it to the Work's design mode",
  },
  replaces: {
    type: "array",
    items: { type: "string", minLength: 1 },
    description: "ids of failed Tasks in current_plan that this NEW Task replaces; [] for a retried Task or a Task that replaces nothing",
  },
  wait_for: {
    type: ["object", "null"],
    description: "replan only, on a retried Task: hold it until prerequisites outside this Work are met, then run it again; null otherwise (always null in a plan)",
    properties: {
      reason: { type: "string", minLength: 1, description: "why the Task must wait" },
      conditions: {
        type: "array",
        description: "all must hold before the Task runs again",
        items: objectSchema({
          kind: { type: "string", enum: ["task", "work", "base_branch", "owner"], description: "task: a Task of another Work completes; work: another Work completes; base_branch: the base branch has the given paths (or moves on, when paths is []); owner: only the Owner's resume releases it" },
          target: { type: "string", description: "task: the Task id; work: the Work id or display number such as \"#51\"; base_branch and owner: empty string" },
          paths: { type: "array", items: { type: "string", minLength: 1 }, description: "base_branch only: repository-relative paths that must exist on the base branch; [] for every other kind" },
          description: { type: "string", minLength: 1, description: "what is awaited, in words the Owner can read" },
        }),
      },
    },
    required: ["reason", "conditions"],
    additionalProperties: false,
  },
  base_sync_only: {
    type: ["boolean", "null"],
    description: "true when this Task or attempt's only purpose is to bring the base branch into the Task's branch and make its existing checks pass again; in a replan only on a retried Task or a NEW Task with replaces; null otherwise",
  },
  necessity: objectSchema({
    serves: { type: "string", minLength: 1, description: "the part of the Owner's request this Task serves" },
    if_omitted: { type: "string", minLength: 1, description: "what goes wrong for the request if this Task is not done" },
  }),
  auto_recovery: objectSchema({
    criteria_relaxations: {
      type: "array",
      description: "automatic recovery only, on a retried Task: one entry for each criterion you loosened (changed text or check); [] otherwise",
      items: objectSchema({
        criterion_id: { type: "string", minLength: 1, description: "id of the loosened criterion, e.g. AC2" },
        reason: { type: "string", minLength: 1, description: "why the earlier wording could not be proven inside the Task" },
        keeps: { type: "string", minLength: 1, description: "what the loosened criterion still checks" },
      }),
    },
    criterion_checks: {
      type: "array",
      example: [],
      description: "partial_repeated recovery only: one command for each criterion the repeated partial report left open, which Core runs once in the Task's last worktree to see whether the criterion already holds; [] otherwise",
      items: objectSchema({
        criterion_id: { type: "string", minLength: 1, description: "id of the open criterion, e.g. AC2" },
        argv: { type: "array", items: { type: "string" }, minItems: 1, description: "the command as an argv array (no shell); it must be one of the Project's allowed commands" },
      }),
    },
    rule_applicability: {
      type: "array",
      example: [],
      description: "partial_repeated recovery only: for each open criterion, whether the rule the Worker kept citing really applies to it; [] otherwise (never [] for partial_repeated)",
      items: objectSchema({
        criterion_id: { type: "string", minLength: 1, description: "id of the open criterion" },
        rule: { type: "string", minLength: 1, description: "the rule or constraint the Worker cited or followed, in a short sentence" },
        applies: { type: "boolean", description: "true when the rule applies to this criterion" },
        reason: { type: "string", minLength: 1, description: "why it applies or does not" },
      }),
    },
  }),
});

/** Manager output for mode "plan": at least one Task. */
export const MANAGER_PLAN_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  tasks: {
    type: "array",
    minItems: 1,
    items: MANAGER_TASK_SCHEMA,
    description: "the Tasks of the plan (at least one)",
  },
  skills_used: SKILLS_USED_SCHEMA,
});

/** Manager output for mode "replan": [] means nothing is needed. */
export const MANAGER_REPLAN_OUTPUT_SCHEMA: RoleSchema = objectSchema({
  tasks: {
    type: "array",
    items: MANAGER_TASK_SCHEMA,
    description: "Tasks to retry or add; [] when nothing is missing and no failed Task remains",
  },
  updated_title: {
    type: ["string", "null"],
    minLength: 1,
    description: "the Work's full new title (1-500 characters) when the Owner's request changes it; null otherwise",
  },
  updated_summary: {
    type: ["string", "null"],
    minLength: 1,
    description: "the Work's full revised summary (at most 20,000 characters) reflecting only what the Owner's request changed; null when the request does not affect the summary",
  },
  task_actions: {
    type: "array",
    items: objectSchema({
      task_id: { type: "string", minLength: 1, description: "id of an open Task in current_plan (waiting, ready, running, verifying, paused or blocked)" },
      action: { type: "string", enum: ["cancel", "complete"], description: "cancel: the Task is no longer needed and its Agent is stopped; complete: treat the Task as done and stop its Agent (its worktree is not merged)" },
      reason: { type: "string", minLength: 1, description: "why, in one sentence" },
    }),
    description: "replan after an Owner request only: cancel or complete open Tasks; [] to leave every open Task as it is",
  },
  skills_used: SKILLS_USED_SCHEMA,
});

/** Lesson keys for routing facts, decisions and pitfalls to theme pages. */
const PAGES_LESSON_PROPERTIES = {
  theme: { type: "string", description: "for kind fact, decision or pitfall: choose one title from the `## テーマ` / `## 共通テーマ` list of the injected index; if none fits, give a new short theme title; empty only if it cannot be classified, or for other kinds" },
  cross_project: { type: "boolean", description: "true only if the lesson applies across Projects, not just this one; otherwise false" },
} as const;

export function finalizeOutputSchema(pages: boolean, commitSubject = false): RoleSchema {
  return objectSchema({
  skills_used: SKILLS_USED_SCHEMA,
  skill_proposals: SKILL_PROPOSALS_SCHEMA,
  verdict: withOptional("goals_met", objectSchema({
    verdict: {
      type: "string",
      enum: ["complete", "incomplete"],
      description: "complete if the reports show the Work's goal was achieved, otherwise incomplete",
    },
    summary: { type: "string", description: "one sentence describing what the Work accomplished" },
    ...(commitSubject ? { commit_subject: { type: ["string", "null"], description: "English, imperative-mood, one-line summary of the Work for its commit subject (ASCII only, at most 72 characters); null if you cannot write one" } } : {}),
    missing: {
      type: "array",
      items: withOptional("criterion_ref", objectSchema({
        item: { type: "string", minLength: 1, description: "what is left undone" },
        reason: { type: "string", description: "why it counts as missing, citing the reports" },
        fix: { type: "string", description: "what should be done to complete it" },
        criterion_ref: { type: ["string", "null"], description: "ref from context.criteria_index of the condition this point is about; null when it is about none of them" },
      })),
      example: [],
      description: "one entry per missing point; [] if complete",
    },
    goals_met: {
      type: "array",
      items: objectSchema({
        criterion_ref: { type: "string", minLength: 1, description: "ref of a goal in context.goal_shortfalls (source final_check, resolution null)" },
        evidence: { type: "string", minLength: 1, description: "what in a report of a Task completed after recorded_at shows the goal is now met" },
      }),
      example: [],
      description: "recorded final-check goals that are now met; [] if none",
    },
    unaddressed_backlog_items: {
      type: "array",
      items: objectSchema({
        item_id: { type: "string", minLength: 1, description: "id of an item in context.backlog_items" },
        reason: { type: "string", description: "why the completed Tasks did not address it" },
      }),
      example: [],
      description: "backlog items this Work did not address; [] if all were addressed or there are none",
    },
    lessons: {
      type: "array",
      items: objectSchema({
        lesson: { type: "string", minLength: 1, description: "what was learned in 1–2 sentences" },
        basis: { type: "string", description: "what in this Work shows it" },
        applies_to: { type: "string", description: "which future Work or situations it applies to" },
        kind: {
          type: "string",
          enum: ["procedure", "fact", "decision", "pitfall", "rule_candidate"],
          description: "reusable lesson kind; omit lessons with no reuse value",
        },
        topic: { type: "string", description: "short topic for fact, decision, or pitfall; otherwise empty" },
        procedure: { type: "string", description: "numbered procedure of at least 40 characters for procedure; otherwise empty" },
        rule_text: { type: "string", description: "one-line imperative rule of at most 300 characters for rule_candidate, in general wording with no file names, Project names, Task or Work numbers; otherwise empty" },
        rule_scope: {
          type: "string",
          enum: ["all", "manager", "designer", "worker", "reviewer", "advisor"],
          description: "scope for rule_candidate; all other lesson kinds use all",
        },
        keywords: {
          type: "array",
          items: { type: "string", minLength: 1 },
          description: "3-5 short noun keywords (topic words, product/tool names) for kind fact, decision or pitfall; [] for other kinds. No sentences, no particles or verb endings.",
        },
        ...(pages ? PAGES_LESSON_PROPERTIES : {}),
      }),
      example: [],
      description: `lessons learned for future Work; may be []. ${KNOWLEDGE_EXTERNAL_COMMAND_RULE}`,
    },
  })),
  });
}

/** Manager output for mode "finalize". */
export const MANAGER_FINALIZE_OUTPUT_SCHEMA: RoleSchema = finalizeOutputSchema(false);
/** The finalize output when memory_mode is "pages": lessons also carry theme and cross_project. */
export const MANAGER_FINALIZE_PAGES_OUTPUT_SCHEMA: RoleSchema = finalizeOutputSchema(true);
/** The finalize output when memory_mode is "pages": lessons also carry theme and cross_project. */
