import { defineMessages } from "./define.js";

export const CoreMessages = defineMessages("core", {
  unsupported: {
    ja: "読み込まれているCoreは{feature}に対応していません。",
    en: "The loaded Core does not support {feature}.",
  },
  advisorRestartUnavailable: {
    ja: "読み込まれているCoreでは、常駐Advisorセッションの再起動を利用できません。",
    en: "Persistent Advisor session restart is not available in the loaded Core.",
  },
  advisorInterruptUnavailable: {
    ja: "読み込まれているCoreでは、Advisorターンの中断を利用できません。",
    en: "Advisor turn interruption is not available in the loaded Core.",
  },
  setLanguageUnsupported: {
    ja: "このCoreは言語設定に対応していません。Coreを更新してください。",
    en: "This Core does not support language settings. Update the Core.",
  },
  providerPauseNotFound: {
    ja: "プロバイダーの一時停止が見つかりません。",
    en: "The provider pause was not found.",
  },
  workDetailUnavailable: {
    ja: "Work詳細を取得できませんでした。保存されたWork情報を確認してください。",
    en: "Could not load the Work detail. Check the stored Work information.",
  },
  workDetailIdMismatch: {
    ja: "Work詳細を取得できませんでした。Coreが要求したWorkとは異なるIDを返しました。",
    en: "Could not load the Work detail. Core returned a different ID from the requested Work.",
  },
  builtinProviderNotEditable: {
    ja: "組み込みProviderは編集できません。別のIDでカスタムProviderとして登録してください。",
    en: "Built-in Providers cannot be edited. Register a custom Provider with a different ID.",
  },
  builtinProviderNotDeletable: {
    ja: "組み込みProviderは削除できません。",
    en: "Built-in Providers cannot be deleted.",
  },
  providerIdInvalid: {
    ja: "Provider IDは英数字、ハイフン、アンダースコアを使う64文字以内の値にしてください。",
    en: "The Provider ID must be at most 64 characters of letters, digits, hyphens, and underscores.",
  },
  displayNameInvalid: {
    ja: "displayNameは1〜128文字で指定してください。",
    en: "displayName must be 1 to 128 characters.",
  },
  harnessIdInvalid: {
    ja: "harnessIdはclaude、codex、opencodeのいずれかを指定してください。",
    en: "harnessId must be one of claude, codex, or opencode.",
  },
  backendUrlRequired: {
    ja: "backendUrlを指定してください。カスタムProviderには接続先のhttpまたはhttpsのURLが必要です。",
    en: "Specify backendUrl. A custom Provider needs an http or https destination URL.",
  },
  backendUrlInvalid: {
    ja: "backendUrlはhttpまたはhttpsのURLを指定してください。",
    en: "backendUrl must be an http or https URL.",
  },
  apiKeySourceInvalid: {
    ja: "apiKeySourceはenv:VARIABLE_NAME形式で指定してください。",
    en: "apiKeySource must be in the form env:VARIABLE_NAME.",
  },
  providerNotFound: {
    ja: "指定されたProviderが見つかりません。IDを確認して再試行してください。",
    en: "The specified Provider was not found. Check the ID and try again.",
  },
  connectorAccountIdMissing: {
    ja: "コネクタアカウントの登録で正規のアカウントIDが得られませんでした。",
    en: "Connector account registration did not produce a canonical account id.",
  },
  eventLimitInvalid: {
    ja: "イベント一覧のlimitが不正です。0以上の整数を指定してください。",
    en: "The event list limit is invalid. Specify an integer of 0 or more.",
  },
  coreDistMissing: {
    ja: "Core実行基盤がまだ利用できません。必要なdistをビルドしてから再実行してください。",
    en: "The Core runtime is not available yet. Build the required dist and run again.",
  },
  coreLoadFailed: {
    ja: "Core実行基盤を読み込めませんでした。ビルド成果物と実行環境を確認してください。",
    en: "Could not load the Core runtime. Check the build output and the runtime environment.",
  },
  coreApiMismatch: {
    ja: "Coreの公開APIが契約と一致しません。createCore({db, agentRunner, git, version})を確認してください。",
    en: "The Core public API does not match the contract. Check createCore({db, agentRunner, git, version}).",
  },
});
