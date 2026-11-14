import type { Shardlens } from '@shardlens/discordjs';
import type { ButtonInteraction } from 'discord.js';

// Register your events once for typed track() calls. Without this, any lower_snake_case name is accepted.
declare module '@shardlens/core' {
  interface CustomEvents {
    ticket_opened: { category: 'billing' | 'support' | 'other'; priority: number };
    ticket_closed: { category: 'billing' | 'support' | 'other'; resolved: boolean };
  }
}

declare const lens: Shardlens;

export function onOpenTicket(interaction: ButtonInteraction, category: 'billing' | 'support' | 'other') {
  // The user ID is hashed inside your bot before anything is sent.
  lens.track('ticket_opened', { category, priority: 2 }, { userId: interaction.user.id, guildId: interaction.guildId });
}
