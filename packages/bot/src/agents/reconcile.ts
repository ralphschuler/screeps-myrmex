import type { ContractTransitionRequest, LeasedWorkExecution } from "../contracts";
import type { MovementRuntimeResult } from "../movement";

/** Converts same-tick typed executor evidence into the sole ContractLedger transition channel. */
export function reconcileLeaseAgentActions(
  leases: readonly LeasedWorkExecution[],
  movement: MovementRuntimeResult,
  tick: number,
): readonly ContractTransitionRequest[] {
  const leaseByCorrelation = new Map(
    leases.map((lease) => [`${lease.contractId}:${String(lease.revision)}`, lease]),
  );
  const transitions: ContractTransitionRequest[] = [];
  const submitted = new Set<string>();
  for (const result of movement.actionExecution) {
    const contractId = result.intent.contractId;
    const revision = result.intent.contractRevision;
    if (contractId === null || revision === null) continue;
    const lease = leaseByCorrelation.get(`${contractId}:${String(revision)}`);
    if (lease === undefined || submitted.has(contractId)) continue;
    if (result.status === "executed" && lease.state === "assigned") {
      transitions.push({ contractId, reason: "agent-action-scheduled", tick, to: "active" });
      submitted.add(contractId);
      continue;
    }
    if (
      result.reason === "adapter-fault" ||
      result.reason === "stale-actor" ||
      result.reason === "stale-target" ||
      result.reason === "unexpected-game-rejection"
    ) {
      transitions.push({ contractId, reason: `agent-${result.reason}`, tick, to: "suspended" });
      submitted.add(contractId);
    }
  }
  return Object.freeze(
    transitions.sort((left, right) => compareStrings(left.contractId, right.contractId)),
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
