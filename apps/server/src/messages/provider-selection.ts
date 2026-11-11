import { defineMessages } from "./define.js";

export const ProviderSelectionMessages = defineMessages("providerSelection", {
  modeInvalid: { ja: "OWL_PROVIDERはstubまたはrealのいずれかを指定してください。", en: "Set OWL_PROVIDER to stub or real." },
  adapterInvalid: {
    ja: "OWL_PROVIDER_ADAPTERはclaude-cli/v1またはcodex-cli/v1で指定してください。",
    en: "Set OWL_PROVIDER_ADAPTER to claude-cli/v1 or codex-cli/v1.",
  },
  adapterUnresolved: {
    ja: "real providerのadapter設定を解決できません。OWL_PROVIDER_ADAPTER=claude-cli/v1またはcodex-cli/v1を指定してください。",
    en: "Could not resolve the real Provider adapter. Set OWL_PROVIDER_ADAPTER to claude-cli/v1 or codex-cli/v1.",
  },
  opencodeModelMissing: {
    ja: "opencodeにはデフォルトのモデルがありません。OWL_PROVIDER_MODELへprovider/modelの形式で指定してください。",
    en: "opencode has no default model. Set OWL_PROVIDER_MODEL to a provider/model id.",
  },
  executableNotAbsolute: { ja: "{env}は絶対パスで指定してください。", en: "Set {env} to an absolute path." },
  executableMissing: {
    ja: "{harness} provider ({adapter}) が必要です。{env}へ絶対パスを指定するか、{binary}をPATHへ追加してください。Owlはprovider CLIを自動インストールしません。",
    en: "The {harness} Provider ({adapter}) is required. Set {env} to an absolute path or add {binary} to PATH. Owl does not install Provider CLIs.",
  },
});
