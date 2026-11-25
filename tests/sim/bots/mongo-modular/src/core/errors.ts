export class AppError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigError extends AppError {}

/**
 * An error the person running the command should see (cooldowns, missing permissions, bad input). The error handler
 * shows its message and does not log it as a failure.
 */
export class UserError extends AppError {}

export class CooldownError extends UserError {
  constructor(readonly retryAfterMs: number) {
    super(`Slow down! You can use this again in ${Math.ceil(retryAfterMs / 1000)}s.`);
  }
}

export class MissingPermissionsError extends UserError {
  constructor(
    readonly who: 'user' | 'bot',
    readonly missing: readonly string[],
  ) {
    super(
      who === 'user'
        ? `You need these permissions: ${missing.join(', ')}`
        : `I'm missing these permissions here: ${missing.join(', ')}`,
    );
  }
}

export class GuildOnlyError extends UserError {
  constructor() {
    super('This command only works in servers.');
  }
}

export class ValidationError extends UserError {}
