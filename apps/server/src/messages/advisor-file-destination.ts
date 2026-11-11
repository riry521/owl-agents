import { defineMessages } from "./define.js";

export const AdvisorFileDestinationMessages = defineMessages("advisor-file-destination", {
  onlyTwoKeys: { ja: "preferred_providerとdefault_destinationだけを指定してください。", en: "Set only preferred_provider and default_destination." },
  preferredProviderInvalid: { ja: "preferred_providerはslack、discord、nullのどれかで指定してください。", en: "Set preferred_provider to slack, discord, or null." },
  destinationInvalid: { ja: "default_destinationはprovider(slackかdiscord)と1〜200文字のchannel_idで指定してください。", en: "Set default_destination to a provider (slack or discord) and a channel_id of 1 to 200 characters." },
  notConfigured: { ja: "{label} の連携が設定されていません。連携設定で Connector を設定してから選んでください。", en: "{label} is not connected. Set up the Connector in the connection settings, then choose it." },
  channelNotSelectable: { ja: "このチャンネルは選べません。会話チャンネルか窓のチャンネルから選んでください。", en: "This channel cannot be chosen. Choose a conversation channel or a window channel." },
});
