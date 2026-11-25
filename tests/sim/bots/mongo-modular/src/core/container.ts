/** A typed key for the container. The type parameter only exists at compile time. */
export interface Token<T> {
  readonly id: symbol;
  readonly name: string;
  readonly __type?: T;
}

export function token<T>(name: string): Token<T> {
  return { id: Symbol(name), name };
}

type Factory<T> = (container: Container) => T;

/**
 * Tiny service container: everything is a lazily created singleton. Modules register their services in
 * `register()` and resolve what they need in `setup()`.
 */
export class Container {
  private readonly factories = new Map<symbol, Factory<unknown>>();
  private readonly instances = new Map<symbol, unknown>();
  private readonly resolving = new Set<symbol>();

  register<T>(key: Token<T>, factory: Factory<T>): this {
    if (this.has(key)) throw new Error(`${key.name} is already registered`);
    this.factories.set(key.id, factory);
    return this;
  }

  value<T>(key: Token<T>, value: T): this {
    if (this.has(key)) throw new Error(`${key.name} is already registered`);
    this.instances.set(key.id, value);
    return this;
  }

  has(key: Token<unknown>): boolean {
    return this.instances.has(key.id) || this.factories.has(key.id);
  }

  resolve<T>(key: Token<T>): T {
    if (this.instances.has(key.id)) return this.instances.get(key.id) as T;
    const factory = this.factories.get(key.id);
    if (!factory) throw new Error(`Nothing registered for ${key.name}`);
    if (this.resolving.has(key.id)) throw new Error(`Circular dependency while resolving ${key.name}`);
    this.resolving.add(key.id);
    try {
      const instance = factory(this);
      this.instances.set(key.id, instance);
      return instance as T;
    } finally {
      this.resolving.delete(key.id);
    }
  }
}
