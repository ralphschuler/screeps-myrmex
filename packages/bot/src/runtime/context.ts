import type { ArbitrationBatch } from "../execution";
import type { ColonyPlanningResult } from "../colony";
import type { RuntimeConfig, RuntimeConfigResolutionMetadata } from "../config";
import type { MemoryCommitResult } from "../state/memory";
import type { StateView } from "../state/schema";
import type { TickTelemetry } from "../telemetry/metrics";
import type { WorldSnapshot } from "../world/snapshot";

export interface RuntimeGame {
  readonly cpu: {
    readonly bucket: number;
    readonly limit: number;
    readonly tickLimit: number;
    getUsed(): number;
  };
  readonly rooms: Readonly<Record<string, Room>>;
  readonly shard: {
    readonly name: string;
  };
  readonly time: number;
}

export interface TickContext {
  readonly tick: number;
  readonly shard: string;
  readonly memoryStatus: "ready" | "recovery" | "unsupported";
  /** The sole recursively immutable policy view for every admitted system. */
  readonly config: RuntimeConfig;
  /** Bounded reason codes only; the raw override owner is never exposed to systems. */
  readonly configResolution: RuntimeConfigResolutionMetadata;
  /** Detached durable input. Systems never receive mutable Memory. */
  readonly state: StateView | null;
  /** The current tick's immutable observation, or an explicit empty value before Observe commits. */
  readonly snapshot: WorldSnapshot;
  /** Immutable tick-local colony lifecycle and budget authorization view. */
  readonly colony: ColonyPlanningResult;
  readonly execution: ArbitrationBatch | null;
  readonly stateCommit: MemoryCommitResult | null;
  readonly telemetry: TickTelemetry | null;
}
