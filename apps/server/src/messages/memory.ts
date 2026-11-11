import { defineMessages } from "./define.js";

export const MemoryMessages = defineMessages("memory", {
  invalidField: { ja: "{field}が不正です。", en: "{field} is invalid." },
  bodyNotObject: { ja: "本文はJSON objectで指定してください。", en: "Send the body as a JSON object." },
  appendAdvisorOnly: { ja: "ナレッジへの追記は Advisor だけができます。", en: "Only the Advisor can append to knowledge." },
  sectionAndTextRequired: { ja: "sectionとtextを指定してください。", en: "Set section and text." },
  appendToolUnsupported: { ja: "読み込み済みの Core は追記ツールに対応していません。", en: "The loaded Core does not support the append tool." },
  appendUnavailable: { ja: "追記先を使えません。", en: "The append target is not available." },
  appendFailed: { ja: "追記できません: {reason}", en: "Could not append: {reason}" },
  pageToolsUnsupported: { ja: "読み込み済みの Core はページツールに対応していません。", en: "The loaded Core does not support the page tools." },
  pageRequired: { ja: "pageを指定してください。", en: "Set page." },
  queryRequired: { ja: "queryを指定してください。", en: "Set query." },
  noteRequired: { ja: "noteを指定してください。", en: "Set note." },
  integrateBodyNotObject: { ja: "bodyはJSON objectで指定してください。", en: "The body must be a JSON object." },
  integratePathsInvalid: { ja: "pathsは空でない文字列の配列で指定してください。", en: "paths must be an array of non-empty strings." },
});
