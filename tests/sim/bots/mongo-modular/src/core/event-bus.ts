import type { Logger } from './logger.js';

export type VoteChoice = 'yes' | 'no';

/** Domain events modules use to talk to each other without importing each other. */
export interface BotEvents {
  'guild.joined': { guildId: string; name: string; memberCount: number };
  'guild.left': { guildId: string };
  'settings.prefixChanged': { guildId: string; prefix: string };
  'poll.created': { pollId: string; guildId: string };
  'poll.voted': { messageId: string; guildId: string | null; choice: VoteChoice; firstVote: boolean };
}

export type EventName = keyof BotEvents;
type Handler<E extends EventName> = (payload: BotEvents[E]) => unknown;

export class EventBus {
  private readonly handlers = new Map<EventName, Set<Handler<never>>>();

  constructor(private readonly logger: Logger) {}

  on<E extends EventName>(event: E, handler: Handler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  /** Handlers run synchronously in order; async ones are not awaited, but their errors are logged. */
  emit<E extends EventName>(event: E, payload: BotEvents[E]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        const result = (handler as Handler<E>)(payload);
        if (result instanceof Promise) {
          result.catch((error: unknown) => this.logger.error(`Handler for ${event} failed`, { error }));
        }
      } catch (error) {
        this.logger.error(`Handler for ${event} failed`, { error });
      }
    }
  }
}
