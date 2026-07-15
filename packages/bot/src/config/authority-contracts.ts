import type { RuntimeConfig } from "./contracts";
import type { CanonicalRuntimeOverrides } from "./validation";

export const RUNTIME_CONFIG_OWNER_SCHEMA_VERSION = 1 as const;

export interface RuntimeConfigCandidate {
  readonly revision: number;
  readonly overrides: unknown;
}

export interface RuntimeConfigLastValid {
  readonly sourceRevision: string;
  readonly candidateRevision: number;
  readonly overrides: CanonicalRuntimeOverrides;
  readonly resolvedRevision: string;
}

export interface RuntimeConfigOwnerV1 {
  readonly schemaVersion: typeof RUNTIME_CONFIG_OWNER_SCHEMA_VERSION;
  readonly candidate: RuntimeConfigCandidate | null;
  readonly lastValid: RuntimeConfigLastValid | null;
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
  readonly replacementOwner: RuntimeConfigOwnerV1 | null;
}
