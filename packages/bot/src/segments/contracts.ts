export const SEGMENT_PRIORITIES = [
  "safety-intel",
  "active-operation",
  "active-colony-remote",
  "optional-analysis",
] as const;

export type SegmentPriority = (typeof SEGMENT_PRIORITIES)[number];

export const SEGMENT_MANAGER_LIMITS = Object.freeze({
  maximumActiveSegments: 10,
  maximumCompactionStepsPerTick: 8,
  maximumEntries: 32,
  maximumKeyCodeUnits: 128,
  maximumManifestCodeUnits: 64_000,
  maximumQuarantineEntries: 100,
  maximumReadCodeUnitsPerTick: 200_000,
  maximumReadsPerTick: 64,
  maximumRegisteredStores: 32,
  maximumSegmentCodeUnits: 100_000,
  maximumVerificationCodeUnitsPerTick: 100_000,
  maximumStoreIdCodeUnits: 96,
  maximumWriteRequestsPerTick: 32,
  maximumWritesPerTick: 2,
  maximumWriteCodeUnitsPerTick: 200_000,
  pendingWriteTimeoutTicks: 10,
  quarantineTicks: 5,
} as const);

export const SEGMENT_OWNER_SCHEMA_VERSION = 1 as const;
export const SEGMENT_ENVELOPE_SCHEMA_VERSION = 1 as const;

export interface SegmentCodec<Value> {
  readonly encode: (value: Value) => string;
  readonly decode: (encoded: string) => Value;
}

export interface SegmentStoreContract<Key, Value> {
  readonly id: string;
  readonly owner: string;
  readonly schemaVersion: number;
  readonly priority: SegmentPriority;
  readonly maximumEncodedLength: number;
  readonly keyOf: (key: Key) => string;
  readonly codec: SegmentCodec<Value>;
}

export type SegmentReadResult<Value> =
  | {
      readonly status: "ready";
      readonly generation: number;
      readonly value: Value;
    }
  | {
      readonly status: "loading";
      readonly reason:
        | "activation-pending"
        | "fallback-pending"
        | "read-budget"
        | "service-unavailable"
        | "write-pending";
    }
  | { readonly status: "missing" }
  | {
      readonly status: "corrupt";
      readonly reason: "checksum" | "codec" | "schema";
    };

export type SegmentWriteResult =
  | { readonly accepted: true; readonly status: "offered" }
  | {
      readonly accepted: false;
      readonly status: "rejected";
      readonly reason:
        | "closed"
        | "codec"
        | "conflict"
        | "key"
        | "oversized"
        | "service-unavailable"
        | "write-budget";
    };

export interface SegmentStore<Key, Value> {
  read(key: Key): SegmentReadResult<Value>;
  write(key: Key, value: Value): SegmentWriteResult;
}

export interface SegmentService {
  register<Key, Value>(contract: SegmentStoreContract<Key, Value>): SegmentStore<Key, Value>;
}

export interface SegmentGenerationRef {
  readonly segmentId: number;
  readonly schemaVersion: number;
  readonly generation: number;
  readonly checksum: string;
  readonly size: number;
  readonly writtenAtTick: number;
}

export interface SegmentPendingGeneration extends SegmentGenerationRef {
  readonly state: "allocated" | "written";
  readonly createdAtTick: number;
}

export interface SegmentManifestEntry {
  readonly storeId: string;
  readonly key: string;
  readonly priority: SegmentPriority;
  readonly lastAccessTick: number;
  readonly current: SegmentGenerationRef | null;
  readonly previous: SegmentGenerationRef | null;
  readonly pending: SegmentPendingGeneration | null;
}

export type SegmentQuarantineReason = "checksum" | "envelope" | "pending-timeout" | "schema";

export interface SegmentQuarantineEntry {
  readonly segmentId: number;
  readonly quarantinedAtTick: number;
  readonly retryAtTick: number;
  readonly reason: SegmentQuarantineReason;
}

export interface SegmentOwnerStateV1 {
  readonly schemaVersion: typeof SEGMENT_OWNER_SCHEMA_VERSION;
  readonly revision: number;
  readonly recoveryCount: number;
  readonly entries: readonly SegmentManifestEntry[];
  readonly quarantine: readonly SegmentQuarantineEntry[];
}

export type SegmentOwnerStatus = "ready" | "initialized" | "recovered" | "unsupported";

export interface SegmentManagerMetrics {
  readonly ownerStatus: SegmentOwnerStatus | "unavailable";
  readonly rawMemoryAvailable: boolean;
  readonly registeredStores: number;
  readonly manifestEntries: number;
  readonly manifestCodeUnits: number;
  readonly activatedSegments: number;
  readonly readsReady: number;
  readonly readsLoading: number;
  readonly readsMissing: number;
  readonly readsCorrupt: number;
  readonly readBudgetDenied: number;
  readonly readCodeUnits: number;
  readonly verifiedGenerations: number;
  readonly verificationCodeUnits: number;
  readonly writes: number;
  readonly writeCodeUnits: number;
  readonly deferredWrites: number;
  readonly rejectedWrites: number;
  readonly quarantined: number;
  readonly fallbackReads: number;
  readonly evictions: number;
  readonly compactionSteps: number;
  readonly pendingWrites: number;
}

export interface SegmentEnvelopeV1 {
  readonly version: typeof SEGMENT_ENVELOPE_SCHEMA_VERSION;
  readonly storeId: string;
  readonly key: string;
  readonly schemaVersion: number;
  readonly generation: number;
  readonly checksum: string;
  readonly payload: string;
}
