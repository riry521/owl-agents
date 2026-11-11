import { defineMessages } from "./define.js";

export const CommonMessages = defineMessages("common", {
  unexpected: {
    ja: "サーバーで処理できない状態が発生しました。要求を完了できませんでした。ログの参照IDを確認してください。",
    en: "The server could not complete the request. Check the logs using the reference ID.",
  },
});
