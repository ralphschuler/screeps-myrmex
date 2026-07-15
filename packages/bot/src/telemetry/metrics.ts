import type { CacheManagerMetrics } from "../cache";
import {
  FEATURE_GATE_IDS,
  type FeatureGateId,
  type FeatureGateReason,
  type RuntimeConfig,
  type RuntimeConfigResolutionMetadata,
} from "../config";
import type { WorldSnapshot } from "../world/snapshot";

export interface FeatureGateTelemetry {
  readonly id: FeatureGateId;
  readonly enabled: boolean;
  readonly reason: FeatureGateReason;
  readonly blockedBy: FeatureGateId | null;
}

export interface TickTelemetry {
  readonly tick: number;
  readonly shard: string;
  readonly memoryStatus: "ready" | "recovery" | "unsupported";
  readonly cpuBucket: number;
  readonly ownedRooms: number;
  readonly snapshotBytes: number;
  readonly cacheEntries: number;
  readonly cacheNamespaces: number;
  readonly configSourceRevision: string;
  readonly configRevision: string;
  readonly policyRevision: string;
  readonly configStatus: RuntimeConfigResolutionMetadata["status"];
  readonly configReasonCode: RuntimeConfigResolutionMetadata["reasonCode"];
  readonly configCandidateRevision: number | null;
  readonly configAcceptedCandidateRevision: number | null;
  readonly featureGates: readonly FeatureGateTelemetry[];
}

export interface TickTelemetryInput {
  readonly tick: number;
  readonly shard: string;
  readonly memoryStatus: TickTelemetry["memoryStatus"];
  readonly cpuBucket: number;
  readonly snapshot: WorldSnapshot;
  readonly cache: CacheManagerMetrics;
  readonly config: RuntimeConfig;
  readonly configResolution: RuntimeConfigResolutionMetadata;
}

/** Creates a bounded, immutable per-tick summary; durable history is a later telemetry policy. */
export function recordTickTelemetry(input: TickTelemetryInput): TickTelemetry {
  return Object.freeze({
    tick: input.tick,
    shard: input.shard,
    memoryStatus: input.memoryStatus,
    cpuBucket: input.cpuBucket,
    ownedRooms: input.snapshot.ownedRooms.length,
    snapshotBytes: input.snapshot.stats.estimatedPayloadBytes,
    cacheEntries: input.cache.entries,
    cacheNamespaces: input.cache.namespaces.length,
    configSourceRevision: input.config.sourceRevision,
    configRevision: input.config.revision,
    policyRevision: input.config.policyRevision,
    configStatus: input.configResolution.status,
    configReasonCode: input.configResolution.reasonCode,
    configCandidateRevision: input.configResolution.candidateRevision,
    configAcceptedCandidateRevision: input.configResolution.acceptedCandidateRevision,
    featureGates: Object.freeze(
      FEATURE_GATE_IDS.map((id) =>
        Object.freeze({
          id,
          enabled: input.config.features.gates[id].enabled,
          reason: input.config.features.gates[id].reason,
          blockedBy: input.config.features.gates[id].blockedBy,
        }),
      ),
    ),
  });
}
