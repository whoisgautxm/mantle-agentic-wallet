import type { ProtocolAction, ProtocolAdapter, ProtocolRegistryEntry } from "./types.js";

function validateEntry(entry: ProtocolRegistryEntry): void {
  if (!entry.id.trim()) throw new Error("protocol adapter id cannot be empty");
  if (entry.supportedActions.length === 0) throw new Error(`protocol ${entry.id} must support at least one action`);
}

export class ProtocolRegistry {
  private readonly entries = new Map<string, ProtocolRegistryEntry>();

  constructor(entries: readonly ProtocolRegistryEntry[] = []) {
    for (const entry of entries) this.register(entry);
  }

  register(entry: ProtocolRegistryEntry): ProtocolRegistryEntry {
    validateEntry(entry);
    if (this.entries.has(entry.id)) throw new Error(`protocol adapter already registered: ${entry.id}`);
    this.entries.set(entry.id, entry);
    return entry;
  }

  get(id: string): ProtocolRegistryEntry | undefined {
    return this.entries.get(id);
  }

  require(id: string): ProtocolRegistryEntry {
    const entry = this.get(id);
    if (!entry) throw new Error(`unknown protocol adapter: ${id}`);
    return entry;
  }

  requireExecutable(id: string): ProtocolAdapter {
    const entry = this.require(id);
    if (entry.mode !== "execution") throw new Error(`protocol adapter is not executable: ${id}`);
    return entry;
  }

  list(): ProtocolRegistryEntry[] {
    return [...this.entries.values()];
  }

  executableAdapters(): ProtocolAdapter[] {
    return this.list().filter((entry): entry is ProtocolAdapter => entry.mode === "execution");
  }

  supportedActions(id: string): readonly ProtocolAction[] {
    return this.require(id).supportedActions;
  }

  allowedTargets(): `0x${string}`[] {
    return [...new Set(this.executableAdapters().map((entry) => entry.target))];
  }

  allowedSelectors(): `0x${string}`[] {
    return [...new Set(this.executableAdapters().flatMap((entry) => entry.allowedSelectors))];
  }
}

export function createProtocolRegistry(entries: readonly ProtocolRegistryEntry[] = []): ProtocolRegistry {
  return new ProtocolRegistry(entries);
}
