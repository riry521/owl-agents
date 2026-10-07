import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from "discord.js";
import {
  CARD_TEXT,
  DETAIL_COLOR,
  truncateText,
  type NotificationCard,
  type OwlLanguage,
} from "@owl/plugin-sdk/shared";

export function renderDiscordCard(card: NotificationCard): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const title = truncateText(`${card.emoji} ${card.title}`, 256);
  const fields = card.fields.slice(0, 25).map((field) => ({
    name: truncateText(field.label, 256),
    value: truncateText(field.value, 1024),
    inline: false,
  }));
  const footer = card.footer ? truncateText(card.footer, 2048) : null;
  const used = title.length + (footer?.length ?? 0) + fields.reduce((total, field) => total + field.name.length + field.value.length, 0);
  const embed = new EmbedBuilder().setColor(discordColor(card.color)).setTitle(title).setTimestamp(new Date());
  if (card.body) embed.setDescription(truncateText(card.body, Math.max(1, Math.min(4096, 5900 - used))));
  if (fields.length > 0) embed.addFields(fields);
  if (footer) embed.setFooter({ text: footer });

  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let index = 0; index < card.actions.length && components.length < 5; index += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      card.actions.slice(index, index + 5).map((action) => new ButtonBuilder()
        .setCustomId(action.id)
        .setLabel(truncateText(action.label, 80))
        .setStyle(action.recommended ? ButtonStyle.Primary : ButtonStyle.Secondary)),
    );
    components.push(row);
  }
  return { embeds: [embed], components };
}

export function renderDiscordDecisionDetail(detail: string, language: OwlLanguage): { embeds: EmbedBuilder[] } {
  return {
    embeds: [new EmbedBuilder()
      .setColor(discordColor(DETAIL_COLOR))
      .setTitle(`📝 ${CARD_TEXT[language].detailTitle}`)
      .setDescription(truncateText(detail, 4096))],
  };
}

export function discordTimestamp(epochMs: number): string {
  return `<t:${Math.floor(epochMs / 1000)}:f>`;
}

function discordColor(color: string): number {
  return /^#[0-9a-f]{6}$/iu.test(color) ? Number.parseInt(color.slice(1), 16) : 0x607d8b;
}
