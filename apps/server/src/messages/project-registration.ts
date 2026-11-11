import { defineMessages } from "./define.js";

export const ProjectRegistrationMessages = defineMessages("project-registration", {
  chooseUnderHome: { ja: "ホームフォルダの下にあるフォルダを選んでください。", en: "Choose a folder under your home folder." },
  browseHomeOnly: { ja: "フォルダの選択では、ホームフォルダの下にあるフォルダだけを表示できます。", en: "The folder picker can only browse folders under your home folder." },
  notAFolder: { ja: "選んだ場所はフォルダではありません。", en: "The selected location is not a folder." },
  pathNotAbsolute: { ja: "Project のフォルダは絶対パスで指定してください。", en: "Project folder path must be absolute." },
  bareRepository: { ja: "bare の Git リポジトリは Project のフォルダに使えません。作業用のフォルダを選んでください。", en: "A bare Git repository cannot be used as a project folder. Choose a working folder instead." },
  noBaseBranch: { ja: "Git リポジトリにコミットはありますが、起点に選べるブランチがありません。", en: "Git repository has a commit but no branch can be selected as its starting point." },
  excludeNotRegularFile: { ja: "Project の Git の exclude ファイルが通常のファイルではありません。中身を確かめてから続けてください。", en: "The project's local Git exclude file is not a regular file. Review it before continuing." },
  snapshotPrepareFailed: { ja: "最初のスナップショットを用意できませんでした。", en: "Could not prepare the initial project snapshot." },
  snapshotCommitFailed: { ja: "最初のスナップショットを作れませんでした。", en: "Could not create the initial project snapshot." },
  branchChanged: { ja: "Git の準備中に Project のブランチが変わりました。リポジトリを確かめて、もう一度試してください。", en: "The project branch changed during Git setup. Inspect the repository and retry." },
  newDestinationInvalid: { ja: "新しい Project の保存先には、正しい絶対パスのフォルダを選んでください。", en: "Choose a valid, absolute destination folder for the new project." },
  newParentNotFolder: { ja: "新しい Project を置く場所はフォルダではありません。", en: "The parent location for the new project is not a folder." },
  newDestinationExists: { ja: "選んだ保存先はすでにあります。空の新しい場所を選ぶか、既存の Project として登録してください。", en: "The selected destination already exists. Choose an empty new location or register it as an existing project." },
  gitInitFailed: { ja: "このフォルダで Git を初期化できませんでした。", en: "Git could not be initialized for this folder." },
  existingFolderMissing: { ja: "選んだ既存の Project のフォルダが見つかりません。", en: "The selected existing project folder is not available." },
  gitNotReady: { ja: "Git は用意しましたが、Project はまだ使える状態になっていません。", en: "Git was prepared, but the project is not ready yet." },
});
