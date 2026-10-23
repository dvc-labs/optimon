import type { Client, EmbedBuilder } from 'discord.js';
import type { Config } from './config.js';

export class BotReporter {
  constructor(private readonly client: Pick<Client, 'channels'>,
    private readonly config: Pick<Config, 'channelId' | 'guildId'>) {}

  async send(embed: EmbedBuilder): Promise<void> {
    const channel = await this.client.channels.fetch(this.config.channelId);
    if (!channel || channel.id !== this.config.channelId || !channel.isSendable() ||
        channel.isDMBased() || channel.guildId !== this.config.guildId) {
      const error = new Error('Report channel must match the configured guild and channel.');
      error.name = 'ReportChannelMismatch';
      throw error;
    }
    // Use the existing bot session; discord.js handles request queues and rate limits.
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  }
}
