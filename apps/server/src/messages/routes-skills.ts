import { defineMessages } from "./define.js";

export const SkillsRouteMessages = defineMessages("routes-skills", {
  ownerOnly: { ja: "ルール提案にアクセスできるのは Owner だけです。", en: "Only the Owner can access rule proposals." },
  invalidResult: { ja: "ルール提案のコマンドが不正な結果を返しました。", en: "Rule proposal command returned an invalid result." },
  notActionable: { ja: "提案は操作できる状態ではありません。", en: "The proposal is not in an actionable state." },
  applyFailed: { ja: "ルール提案を適用できませんでした。", en: "The rule proposal could not be applied." },
  requestInvalid: { ja: "ルール提案のリクエストが不正です。", en: "The rule proposal request is invalid." },
  resourceNotFound: { ja: "指定されたルール提案のリソースが見つかりません。", en: "The requested rule proposal resource was not found." },
  idNotUlid: { ja: "{field}はULIDで指定してください。", en: "{field} must be a ULID." },
  daysInvalid: { ja: "daysは1〜90の整数で指定してください。", en: "days must be an integer between 1 and 90." },
  skillUpdateEmpty: { ja: "Skill の更新にはstate、scopeのどちらか、または両方が必要です。", en: "Skill update must contain state, scope, or both." },
  stateNotString: { ja: "stateは文字列で指定してください。", en: "state must be a string." },
  scopeNotString: { ja: "scopeは文字列で指定してください。", en: "scope must be a string." },
  commandRequired: { ja: "commandフィールドが必要です。", en: "The command field is required." },
  roleInvalid: { ja: "roleは {roles} のいずれかで指定してください。", en: "Set role to one of {roles}." },
  cwdNotAbsolute: { ja: "cwdは絶対パスで指定してください。", en: "Set cwd to an absolute path." },
  skillBoxUnsupported: { ja: "読み込み済みの Core はSkill Box APIに対応していません。", en: "The loaded Core does not support the Skill Box API." },
  ruleProposalUnsupported: { ja: "読み込み済みの Core はルール提案 APIに対応していません。", en: "The loaded Core does not support the rule proposal API." },
});
