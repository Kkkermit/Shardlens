/**
 * An area of the store not written yet: every method rejects, naming itself. Removed once every area is written.
 */
export function pending<T extends object>(area: string): T {
  return new Proxy({} as T, {
    get(_target, method) {
      if (typeof method !== 'string' || method === 'then') return undefined;
      return () => Promise.reject(new Error(`MongoStore: ${area}.${method} is not written yet`));
    },
  });
}

/** As {@link pending}, for part of an area that is spread into the whole (a proxy has no keys to spread). */
export function pendingMethods<T extends object>(area: string, methods: readonly (keyof T & string)[]): T {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      () => Promise.reject(new Error(`MongoStore: ${area}.${method} is not written yet`)),
    ]),
  ) as T;
}
