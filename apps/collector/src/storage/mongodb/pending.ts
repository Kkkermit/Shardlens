/**
 * Part of an area of the store not written yet, to spread into the whole: every method rejects, naming itself. Removed
 * once every area is written.
 */
export function pendingMethods<T extends object>(area: string, methods: readonly (keyof T & string)[]): T {
  return Object.fromEntries(
    methods.map((method) => [
      method,
      () => Promise.reject(new Error(`MongoStore: ${area}.${method} is not written yet`)),
    ]),
  ) as T;
}
