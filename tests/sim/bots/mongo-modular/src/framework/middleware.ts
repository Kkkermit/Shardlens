import type { Invocation } from './types.js';

export type Next = () => Promise<void>;

/** Runs before a command; throw a UserError to stop it, or call `next()` to carry on. */
export type Middleware = (invocation: Invocation, next: Next) => Promise<void>;

export function compose(middleware: readonly Middleware[], handler: () => Promise<unknown>) {
  return (invocation: Invocation): Promise<void> => {
    const dispatch = async (index: number): Promise<void> => {
      const current = middleware[index];
      if (!current) {
        await handler();
        return;
      }
      await current(invocation, () => dispatch(index + 1));
    };
    return dispatch(0);
  };
}
