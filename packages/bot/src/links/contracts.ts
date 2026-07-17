import type { IntentBudget, IntentPriority } from "../execution";
import type { PositionSnapshot } from "../world/snapshot";

export const MAX_LINK_ARBITRATION_LINKS = 16;
export const MAX_LINK_TRANSFER_PROPOSALS = 64;
export const LINK_TRANSFER_LOSS_RATIO = 0.03;

export type LinkRole = "source" | "hub" | "controller" | "reserve";

export interface LinkRoleAnchor {
  readonly id: string;
  readonly layoutRevision: string;
  readonly pos: PositionSnapshot;
  readonly role: LinkRole;
  readonly sourceId: string | null;
}

export interface LinkLayoutEvidence {
  readonly algorithmRevision: string;
  readonly controller: PositionSnapshot;
  readonly fingerprint: string;
  readonly linkPlacements: readonly PositionSnapshot[];
  readonly sourceServices: readonly {
    readonly pos: PositionSnapshot;
    readonly sourceId: string;
  }[];
  readonly storage: PositionSnapshot | null;
}

export interface ObservedLink {
  readonly active: boolean;
  readonly cooldown: number;
  readonly energy: number;
  readonly freeCapacity: number;
  readonly id: string;
  readonly observedAt: number;
  readonly owned: boolean;
  readonly pos: PositionSnapshot;
}

export interface ClassifiedLink extends ObservedLink {
  readonly anchorId: string;
  readonly layoutRevision: string;
  readonly role: LinkRole;
  readonly sourceId: string | null;
}

export type LinkClassificationBlockerReason =
  | "duplicate-anchor"
  | "duplicate-link"
  | "foreign-link"
  | "inactive-link"
  | "layout-revision-mismatch"
  | "link-cap"
  | "missing-link"
  | "stale-link"
  | "unclassified-link";

export interface LinkClassificationBlocker {
  readonly id: string;
  readonly reason: LinkClassificationBlockerReason;
}

export interface LinkClassificationResult {
  readonly blockers: readonly LinkClassificationBlocker[];
  readonly links: readonly ClassifiedLink[];
  readonly truncatedLinks: number;
}

export interface LinkTransferProposal {
  readonly amount: number;
  readonly budget: IntentBudget;
  readonly deadline: number;
  readonly flowId: string;
  readonly fundingStatus: "active" | "denied" | "pending";
  readonly id: string;
  readonly layoutRevision: string;
  readonly priority: IntentPriority;
  readonly sourceLinkId: string;
  readonly targetLinkId: string;
}

export type LinkTransferDeferralReason =
  | "budget-unavailable"
  | "cooldown"
  | "expired"
  | "foreign-or-inactive"
  | "insufficient-source"
  | "invalid-proposal"
  | "invalid-role"
  | "layout-revision-mismatch"
  | "proposal-cap"
  | "same-link"
  | "source-already-used"
  | "stale-link"
  | "target-full"
  | "unknown-link"
  | "wrong-room"
  | "zero-delivery";

export interface LinkTransferDecision {
  readonly budget: IntentBudget;
  readonly deliveredAmount: number;
  readonly flowId: string;
  readonly lostAmount: number;
  readonly layoutRevision: string;
  readonly proposalId: string;
  readonly sentAmount: number;
  readonly sourceLinkId: string;
  readonly targetLinkId: string;
}

export type LinkTransferAttemptCode =
  | "OK"
  | "ERR_NOT_OWNER"
  | "ERR_NOT_ENOUGH_RESOURCES"
  | "ERR_INVALID_TARGET"
  | "ERR_FULL"
  | "ERR_NOT_IN_RANGE"
  | "ERR_INVALID_ARGS"
  | "ERR_TIRED"
  | "ERR_RCL_NOT_ENOUGH"
  | "DEFERRED_BACKOFF"
  | "UNEXPECTED";

export interface LinkTransferExecutionResult {
  readonly actualDeliveredAmount: number;
  readonly actualLostAmount: number;
  readonly actualSentAmount: number;
  readonly called: boolean;
  readonly code: LinkTransferAttemptCode;
  readonly decision: LinkTransferDecision;
  readonly fault:
    | "adapter-fault"
    | "command-backoff"
    | "duplicate-source"
    | "source-unavailable"
    | "stale-layout"
    | "target-unavailable"
    | null;
}

export interface LinkRoomRuntimeResult {
  readonly arbitration: LinkArbitrationResult;
  readonly classification: LinkClassificationResult;
  readonly layoutRevision: string;
  readonly roomName: string;
}

export interface LinkRuntimeResult {
  readonly execution: readonly LinkTransferExecutionResult[];
  readonly rooms: readonly LinkRoomRuntimeResult[];
  readonly status: "disabled" | "not-run" | "planned";
}

export interface LinkTransferDeferral {
  readonly proposalId: string;
  readonly reason: LinkTransferDeferralReason;
}

export interface LinkArbitrationResult {
  readonly accepted: readonly LinkTransferDecision[];
  readonly deferred: readonly LinkTransferDeferral[];
  readonly evaluatedProposals: number;
  readonly truncatedProposals: number;
}
