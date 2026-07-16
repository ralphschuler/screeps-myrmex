import type { ArbitrationBatch } from "../execution";
import type { ColonyPlanningResult } from "../colony";
import type { RuntimeConfig, RuntimeConfigResolutionMetadata } from "../config";
import type {
  ContractExecutionView,
  ContractPlanningView,
  ContractReconciliationResult,
} from "../contracts";
import type { MemoryCommitResult } from "../state/memory";
import type { SpawnRuntimeResult } from "../spawn";
import type { MovementRuntimeChannels, MovementRuntimeResult } from "../movement";
import type { LocalPathPlanningService } from "../movement";
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
  /** Authoritative name-keyed collection of every owned creep on this shard. */
  readonly creeps: Readonly<Record<string, Creep>>;
  readonly rooms: Readonly<Record<string, Room>>;
  /** Narrow live-object lookup handed only to command executors. */
  readonly getObjectById?: (id: string) => unknown;
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
  /** Immutable tick-local contract reconciliation and workforce-allocation view. */
  readonly contracts: ContractReconciliationResult | null;
  /** Sanitized leased-work authorization for plan systems; never raw contract-owner data. */
  readonly contractExecution: ContractExecutionView;
  /** Sanitized active contract identities for planners that safely renew or retire work. */
  readonly contractPlanning: ContractPlanningView;
  readonly execution: ArbitrationBatch | null;
  /** Bounded data-only channels for admitted movement and primary-action planners. */
  readonly movementChannels: MovementRuntimeChannels;
  /** Canonical data-only local path capability; unavailable service returns typed no-path data. */
  readonly localPathPlanning: LocalPathPlanningService;
  /** Tick-local movement/action arbitration and command evidence. */
  readonly movement: MovementRuntimeResult;
  /** Tick-local spawn arbitration and command evidence. */
  readonly spawn: SpawnRuntimeResult;
  readonly stateCommit: MemoryCommitResult | null;
  readonly telemetry: TickTelemetry | null;
}
