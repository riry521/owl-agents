import { defineMessages } from "./define.js";

export const SystemRouteMessages = defineMessages("routes-system", {
  topInvalid: { ja: "topは1〜50の整数を指定してください。", en: "Set top to an integer from 1 to 50." },
  healthLoopbackOnly: { ja: "healthはloopback接続だけに公開されています。localhostから接続してください。", en: "health is only available on loopback connections. Connect from localhost." },
  coreNotReady: { ja: "Coreが起動準備中または停止処理中です。しばらく待って再試行してください。", en: "The Core is starting up or shutting down. Wait a moment and retry." },
  runtimeConfigLocalOnly: { ja: "runtime configは同一端末から取得してください。localhostから接続してください。", en: "Fetch the runtime config from the same machine. Connect from localhost." },
  periodInvalid: { ja: "periodはtoday、7d、30dのいずれかを指定してください。", en: "Set period to today, 7d, or 30d." },
  thresholdTokensInvalid: { ja: "threshold_tokensは正の整数で指定してください。", en: "threshold_tokens must be a positive integer." },
  showHiddenInvalid: { ja: "show_hiddenは0または1で指定してください。", en: "Set show_hidden to 0 or 1." },
  afterInvalid: { ja: "afterが不正です。0以上の整数カーソルを指定してください。", en: "Set after to an integer cursor of 0 or more." },
  afterTooLarge: { ja: "afterが大きすぎます。現在のイベントカーソルを使ってください。", en: "after is too large. Use the current event cursor." },
  orderInvalid: { ja: "orderが不正です。ascまたはdescを指定してください。", en: "Set order to asc or desc." },
  afterWithDesc: { ja: "order=descではafterを使えません。古いイベントはbeforeで取得してください。", en: "after cannot be used with order=desc. Fetch older events with before." },
  beforeInvalid: { ja: "beforeが不正です。0以上の整数カーソルを指定してください。", en: "Set before to an integer cursor of 0 or more." },
  beforeTooLarge: { ja: "beforeが大きすぎます。直前のページのcursorを使ってください。", en: "before is too large. Use the cursor of the previous page." },
  beforeNeedsDesc: { ja: "beforeはorder=descと一緒に指定してください。", en: "Set before together with order=desc." },
  tokenUsageUnsupported: { ja: "読み込み済みの Core はトークン使用量レポートに対応していません。", en: "The loaded Core does not support token usage reports." },
  requestCountsUnsupported: { ja: "読み込み済みの Core はリクエストのトークン数集計に対応していません。", en: "The loaded Core does not support request token counts." },
  ownerFilesUnsupported: { ja: "読み込み済みの Core はOwner ファイルを開く操作に対応していません。", en: "The loaded Core does not support opening Owner files." },
  tokensViewUnsupported: { ja: "読み込み済みの Core はTokens 画面 APIに対応していません。", en: "The loaded Core does not support the Tokens screen API." },
  reviewMetricsUnsupported: { ja: "読み込み済みの Core はレビュー指標に対応していません。", en: "The loaded Core does not support review metrics." },
  planUsageUnsupported: { ja: "読み込み済みの Core はプラン使用量に対応していません。", en: "The loaded Core does not support plan usage." },
});
