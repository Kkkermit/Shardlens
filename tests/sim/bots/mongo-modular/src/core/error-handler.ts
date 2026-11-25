import { describe } from '../framework/invocation.js';
import type { Invocation } from '../framework/types.js';
import { UserError } from './errors.js';
import type { Logger } from './logger.js';

/** The one place command and component errors end up. */
export class ErrorHandler {
  constructor(private readonly logger: Logger) {}

  async handle(error: unknown, invocation: Invocation): Promise<void> {
    if (error instanceof UserError) {
      this.logger.debug(`${describe(invocation)} rejected: ${error.message}`);
      await this.tell(invocation, error.message);
      return;
    }

    this.logger.error(`${describe(invocation)} failed`, { error });
    await this.tell(invocation, '❌ Something went wrong while running that. The error has been logged.');
  }

  private async tell(invocation: Invocation, content: string): Promise<void> {
    try {
      await invocation.respond(content);
    } catch (error) {
      this.logger.warn(`Could not send the error message for ${describe(invocation)}`, { error });
    }
  }
}
