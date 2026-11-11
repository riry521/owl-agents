import { defineMessages } from "./define.js";

export const ServerMessages = defineMessages("server", {
  alreadyRunning: {
    ja: "owl-coreはすでに起動しています。statusを確認してから再試行してください。",
    en: "owl-core is already running. Check status before retrying.",
  },
  dbRuntimeNotBuilt: {
    ja: "DB実行基盤がまだ利用できません。必要なdistをビルドしてから再実行してください。",
    en: "The database runtime is unavailable. Build the required dist files and retry.",
  },
  dbRuntimeLoadFailed: {
    ja: "DB実行基盤を読み込めませんでした。ビルド成果物を確認してください。",
    en: "Could not load the database runtime. Check the build artifacts.",
  },
  dbApiMismatch: {
    ja: "DBの公開APIが契約と一致しません。openDatabaseを確認してください.",
    en: "The database API does not match the contract. Check openDatabase.",
  },
  dbMigrateApiMismatch: {
    ja: "DB migration APIが契約と一致しません。migrateを確認してください。",
    en: "The database migration API does not match the contract. Check migrate.",
  },
  providerNoAdvisorSessionApi: {
    ja: "実運用ProviderがAdvisorセッションAPIを提供していません。Provider/Harnessの設定を確認してください。",
    en: "The selected Provider does not expose the Advisor session API. Check Provider and Harness settings.",
  },
  harnessNoPersistentSession: {
    ja: "選択したProvider/HarnessはAdvisorの永続セッションをサポートしていません。対応Harnessを選択するか、設定を修正してください。",
    en: "The selected Provider/Harness does not support persistent Advisor sessions. Select a supported Harness or update the settings.",
  },
  httpStartFailed: {
    ja: "HTTP serverを起動できませんでした。bindとportが利用可能か確認してください。",
    en: "Could not start the HTTP server. Check the bind address and port.",
  },
  notRunning: {
    ja: "{message} サーバーは起動していません。",
    en: "{message} The server is not running.",
  },
  connectorStartFailed: {
    ja: "連携の起動に失敗しました。連携設定と外部サービスの状態を確認してください。",
    en: "Could not start the integration. Check its settings and external service status.",
  },
});
