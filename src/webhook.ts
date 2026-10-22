import { Routes, WebhookClient, type EmbedBuilder } from 'discord.js';
import type { Config } from './config.js';

interface Transport {
  fetch(): Promise<unknown>;
  send(payload: { username: string; embeds: EmbedBuilder[]; allowedMentions: { parse: [] } }): Promise<unknown>;
  destroy(): void;
}

function transportFor(url: string): Transport {
  const client = new WebhookClient({ url }, {
    allowedMentions: { parse: [] }, rest: { timeout: 15_000, retries: 2 },
  });
  return {
    fetch: () => client.rest.get(Routes.webhook(client.id, client.token), { auth: false }),
    send: (payload) => client.send(payload),
    destroy: () => client.destroy(),
  };
}

export class WebhookReporter {
  private verified = false;
  private readonly transport: Transport;

  constructor(private readonly config: Config, transport?: Transport) {
    if (!config.webhookUrl) throw new Error('A webhook URL is required for the reporter.');
    this.transport = transport ?? transportFor(config.webhookUrl);
  }

  async send(embed: EmbedBuilder): Promise<void> {
    if (!this.verified) {
      const data = await this.transport.fetch();
      if (typeof data !== 'object' || data === null ||
          !('channel_id' in data) || data.channel_id !== this.config.channelId ||
          !('guild_id' in data) || data.guild_id !== this.config.guildId) {
        const error = new Error('Webhook target does not match the configured guild and channel.');
        error.name = 'WebhookTargetMismatch';
        throw error;
      }
      this.verified = true;
    }
    // discord.js queues requests and handles Discord rate limits.
    await this.transport.send({ username: 'Optiplex', embeds: [embed], allowedMentions: { parse: [] } });
  }

  destroy(): void { this.transport.destroy(); }
}
