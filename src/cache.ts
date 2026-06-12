/**
 * Tiny TTL + size-bounded cache. Keyed by tool name + serialized args so that
 * repeated identical diagnostic calls (a common pattern in agent loops) don't
 * re-spend tokens on the local model.
 */

interface Entry {
  value: string;
  expiresAt: number;
}

export class ResponseCache {
  private cache = new Map<string, Entry>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  key(toolName: string, args: unknown): string {
    return `${toolName}:${JSON.stringify(args ?? {})}`;
  }

  get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // Refresh LRU position.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string): void {
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
