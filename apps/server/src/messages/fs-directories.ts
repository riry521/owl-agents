import { defineMessages } from "./define.js";

export const FsDirectoriesMessages = defineMessages("fsDirectories", {
  notFound: { ja: "フォルダが見つかりません。", en: "The folder was not found." },
  permissionDenied: { ja: "このフォルダを開く権限がありません。", en: "You do not have permission to open this folder." },
  notAbsolute: { ja: "フォルダは絶対パスで指定してください。", en: "Specify the folder as an absolute path." },
  permissionHintFullDisk: { ja: "システム設定 > プライバシーとセキュリティ > フルディスクアクセス", en: "System Settings > Privacy & Security > Full Disk Access" },
  permissionHintFilesAndFolders: { ja: "システム設定 > プライバシーとセキュリティ > ファイルとフォルダ（リムーバブルボリューム／ネットワークボリューム／ファイルプロバイダ）", en: "System Settings > Privacy & Security > Files and Folders (Removable Volumes / Network Volumes / File Provider)" },
  permissionHintSteps: { ja: "Owl を動かしているアプリ（ターミナルや Node）をオンにして、Owl を再起動してください。", en: "Turn on the app that runs Owl (Terminal or Node), then restart Owl." },
  notDirectory: { ja: "フォルダではありません。", en: "This is not a folder." },
});
