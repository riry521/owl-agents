import { defineMessages } from "./define.js";

export const HttpMessages = defineMessages("http", {
  advisorActionRequired: {
    ja: "{reason} 代わりに {alternatives} を使ってください。",
    en: "{reason} Use {alternatives} instead.",
  },
  staticMethodNotAllowed: {
    ja: "静的配信はGETで取得してください。HTTP methodを確認してください。",
    en: "Use GET for static assets. Check the HTTP method.",
  },
  staticPathInvalid: {
    ja: "静的ファイルのpathを解釈できません。URLを確認して再試行してください。",
    en: "The static file path could not be parsed. Check the URL and retry.",
  },
  staticNotFound: {
    ja: "指定された静的ファイルが見つかりません。URLを確認してください。",
    en: "The requested static file was not found. Check the URL.",
  },
  apiEndpointNotFound: {
    ja: "指定されたAPI endpointが見つかりません。pathとHTTP methodを確認してください。",
    en: "The requested API endpoint was not found. Check the path and HTTP method.",
  },
  guardTokenInvalid: {
    ja: "guard tokenが無効か失効しています。Agentを再実行してください。",
    en: "The guard token is invalid or expired. Rerun the agent.",
  },
  websocketOriginForbidden: {
    ja: "このWebSocket接続元は許可されていません。Web UIから接続し直してください。",
    en: "This WebSocket origin is not allowed. Reconnect from the Web UI.",
  },
  websocketKeyMissing: {
    ja: "WebSocket handshakeのkeyがありません。標準のWebSocket clientから接続してください。",
    en: "The WebSocket handshake key is missing. Connect with a standard WebSocket client.",
  },
});
