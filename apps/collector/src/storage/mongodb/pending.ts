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
