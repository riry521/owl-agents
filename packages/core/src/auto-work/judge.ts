import {
  AUTO_WORK_JUDGMENT_UNAVAILABLE, readAutoWorkJudgment,
  type ActorRole, type AutoWorkJudgment, type AutoWorkJudgmentRequest, type AutoWorkJudgmentRunResult,
} from "@owl/shared";

export interface AutoWorkJudgeDeps {
  readonly runner: () => { readonly runAutoWorkJudgment?: (request: AutoWorkJudgmentRequest) => Promise<AutoWorkJudgmentRunResult> };
  readonly roleModel: (role: ActorRole) => { readonly model: string; readonly provider: string; readonly effort: string };
}

export type AutoWorkJudgeOutcome =
  | { readonly ok: true; readonly judgment: AutoWorkJudgment }
  | { readonly ok: false; readonly error: string };

export type AutoWorkJudgeInput = Omit<AutoWorkJudgmentRequest, "model"> & { readonly judge_role: ActorRole };

/** Stage two: asks the model whether the signal is worth a Work. Never throws; every failure comes back as `ok: false`. */
export class AutoWorkJudge {
  public constructor(private readonly deps: AutoWorkJudgeDeps) {}

  public async judge(input: AutoWorkJudgeInput): Promise<AutoWorkJudgeOutcome> {
    try {
      const { judge_role: role, ...rest } = input;
      const run = this.deps.runner().runAutoWorkJudgment;
      if (!run) return { ok: false, error: AUTO_WORK_JUDGMENT_UNAVAILABLE };
      const result = await run({ ...rest, model: this.deps.roleModel(role) });
      if (!result.ok) return { ok: false, error: result.error };
      const known = [...input.open_works.map((work) => work.work_id), ...input.recent_auto_works.map((work) => work.work_id)];
      const read = readAutoWorkJudgment(result.judgment, known);
      return read.ok ? { ok: true, judgment: read.value } : { ok: false, error: `invalid_judgment:${read.problem}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
