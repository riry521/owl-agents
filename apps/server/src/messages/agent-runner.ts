import { defineMessages } from "./define.js";

export const AgentRunnerMessages = defineMessages("agentRunner", {
  runtimeNotBuilt: {
    ja: "Agent実行基盤がまだ利用できません。必要なdistをビルドしてから再実行してください。",
    en: "The agent runtime is not available yet. Build the required dist files and retry.",
  },
  runtimeLoadFailed: {
    ja: "Agent実行基盤を読み込めませんでした。ビルド成果物と実行環境を確認してください。",
    en: "Could not load the agent runtime. Check the build artifacts and the runtime environment.",
  },
  runtimeApiMismatch: {
    ja: "Agent実行基盤の公開APIが契約と一致しません。createAgentRunner/createStubAgentRunnerを確認してください。",
    en: "The agent runtime API does not match the contract. Check createAgentRunner/createStubAgentRunner.",
  },
  providerSettingsUnreadable: {
    ja: "Provider設定を読み込めませんでした。{reason}",
    en: "Could not load the Provider settings. {reason}",
  },
  executableEnvironment: {
    ja: "Provider/Harnessの実行環境を初期化できませんでした。実行ファイルのパス、PATH、権限を確認してください。",
    en: "Could not initialize the Provider/Harness environment. Check the executable path, PATH, and permissions.",
  },
  initializeFailed: {
    ja: "Provider/Harnessを初期化できませんでした。Provider設定、モデル、実行環境を確認してください。",
    en: "Could not initialize the Provider/Harness. Check the Provider settings, model, and runtime environment.",
  },
  envPathMissing: {
    ja: "owl-coreプロセスの起動環境にPATHが設定されていません。owl startを実行するシェルの環境変数を確認してください。",
    en: "PATH is not set in the environment of the owl-core process. Check the environment variables of the shell that runs owl start.",
  },
  envHomeMissing: {
    ja: "owl-coreプロセスの起動環境にHOMEが設定されていません。owl startを実行するシェルの環境変数を確認してください。",
    en: "HOME is not set in the environment of the owl-core process. Check the environment variables of the shell that runs owl start.",
  },
  customProviderEmptyId: {
    ja: "カスタムProvider設定に空のProvider IDがあります。設定を修正してください。",
    en: "A custom Provider setting has an empty Provider ID. Fix the setting.",
  },
  customProviderHarnessUnsupported: {
    ja: "カスタムProvider {providerId} のHarness '{harnessId}'は未対応です。claude、codex、opencodeのいずれかを指定してください。",
    en: "Harness '{harnessId}' of custom Provider {providerId} is not supported. Specify claude, codex, or opencode.",
  },
  customProviderApiKeySourceInvalid: {
    ja: "カスタムProvider {providerId} のapiKeySourceが不正です。env:VARIABLE_NAME形式を指定してください。",
    en: "The apiKeySource of custom Provider {providerId} is invalid. Use the env:VARIABLE_NAME format.",
  },
});
