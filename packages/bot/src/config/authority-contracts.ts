import type { RuntimeConfig } from "./contracts";
import type { CanonicalRuntimeOverrides } from "./validation";

export const RUNTIME_CONFIG_OWNER_SCHEMA_VERSION = 2 as const;

export interface RuntimeConfigCandidate {
  readonly revision: number;
  readonly overrides: unknown;
}

export interface RuntimeConfigLastValid {
  readonly sourceRevision: string;
  readonly candidateRevision: number;
  readonly overrides: CanonicalRuntimeOverrides;
  readonly resolvedRevision: string;
  /** The one-time anchor for an optional observer diagnostic duration. */
  readonly diagnosticExpiresAtTick: number | null;
}

export interface RuntimeConfigOwnerV2 {
  readonly schemaVersion: typeof RUNTIME_CONFIG_OWNER_SCHEMA_VERSION;
  readonly candidate: RuntimeConfigCandidate | null;
  readonly lastValid: RuntimeConfigLastValid | null;
}

/** Legacy durable receipt shape accepted by the v2 authority reader. */
export interface RuntimeConfigOwnerV1 {
  readonly schemaVersion: 1;
  readonly candidate: RuntimeConfigCandidate | null;
  readonly lastValid: Omit<RuntimeConfigLastValid, "diagnosticExpiresAtTick"> | null;
}

export type RuntimeConfigResolutionStatus =
  "source-defaults" | "candidate-accepted" | "last-valid-retained" | "owner-unavailable";

export type RuntimeConfigResolutionReason =
  | "owner-unavailable"
  | "owner-initialized"
  | "owner-malformed"
  | "owner-future-schema"
  | "no-candidate"
  | "candidate-valid"
  | "candidate-invalid"
  | "candidate-stale"
  | "candidate-revision-reused";

export interface RuntimeConfigResolutionMetadata {
  readonly status: RuntimeConfigResolutionStatus;
  readonly reasonCode: RuntimeConfigResolutionReason;
  readonly candidateRevision: number | null;
  readonly acceptedCandidateRevision: number | null;
}

export interface RuntimeConfigResolution {
  readonly config: RuntimeConfig;
  readonly metadata: RuntimeConfigResolutionMetadata;
  /** A detached owner value for the caller to stage through MemoryManager. */
  readonly replacementOwner: RuntimeConfigOwnerV2 | null;
}
