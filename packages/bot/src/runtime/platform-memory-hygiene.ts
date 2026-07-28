export const MAX_CREEP_MEMORY_ENTRIES_INSPECTED_PER_TICK = 128;
export const MAX_STALE_CREEP_MEMORY_DELETIONS_PER_TICK = 64;

export interface CreepMemoryCleanupResult {
  readonly inspected: number;
  readonly removed: number;
}

/**
 * Cleans Screeps' platform-owned creep-memory table without making it gameplay state.
 *
 * Keys are canonicalized before a tick-derived bounded window is inspected. Every stable table is
 * therefore covered deterministically, while one tick can inspect or delete only fixed counts.
 * The Memory platform's own size limit bounds key enumeration and sorting; MYRMEX owner state is
 * never read or changed here.
 */
export function cleanStaleCreepMemory(
  memory: Memory,
  liveCreeps: Readonly<Record<string, unknown>>,
  tick: number,
): CreepMemoryCleanupResult {
  const creepMemory = (memory as unknown as { readonly creeps?: unknown }).creeps;
  if (!isRecord(creepMemory)) return Object.freeze({ inspected: 0, removed: 0 });

  const names = Object.keys(creepMemory).sort(compareStrings);
  if (names.length === 0) return Object.freeze({ inspected: 0, removed: 0 });

  const windowCount = Math.ceil(names.length / MAX_CREEP_MEMORY_ENTRIES_INSPECTED_PER_TICK);
  const normalizedTick = Number.isSafeInteger(tick) && tick >= 0 ? tick : 0;
  const windowIndex = normalizedTick % windowCount;
  const start = windowIndex * MAX_CREEP_MEMORY_ENTRIES_INSPECTED_PER_TICK;
  const inspected = Math.min(MAX_CREEP_MEMORY_ENTRIES_INSPECTED_PER_TICK, names.length - start);
  let removed = 0;

  for (let offset = 0; offset < inspected; offset += 1) {
    const name = names[start + offset];
    if (
      name !== undefined &&
      !Object.prototype.hasOwnProperty.call(liveCreeps, name) &&
      removed < MAX_STALE_CREEP_MEMORY_DELETIONS_PER_TICK &&
      Reflect.deleteProperty(creepMemory, name)
    ) {
      removed += 1;
    }
  }

  return Object.freeze({ inspected, removed });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
