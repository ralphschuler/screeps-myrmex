import type { BudgetRequest, LedgerEntry } from "../colony";
import type { WorkContractRequest } from "../contracts";
import type { WorldSnapshot } from "../world/snapshot";
import type {
  DownstreamCommitment,
  IndustryPlan,
  IndustryRoomState,
  StockBand,
} from "./stock-policy";

export interface IndustryRoomPolicy {
  readonly bands: readonly StockBand[];
  readonly commitments: readonly DownstreamCommitment[];
  readonly protectedEnergy: number;
  readonly roomName: string;
}

export interface IndustryAuthorization {
  readonly budgets: readonly BudgetRequest[];
  readonly extractionContracts: readonly WorkContractRequest[];
}

/** Normalizes current detached observations without retaining live Game objects. */
export function observeIndustryRooms(
  snapshot: WorldSnapshot,
  policies: readonly IndustryRoomPolicy[],
): readonly IndustryRoomState[] {
  const byRoom = new Map(policies.map((policy) => [policy.roomName, policy]));
  return freeze(
    snapshot.ownedRooms
      .map((room): IndustryRoomState | null => {
        const policy = byRoom.get(room.name);
        if (policy === undefined) return null;
        const extractor = room.ownedExtractors?.[0] ?? null;
        const storage = room.ownedStorages?.[0] ?? null;
        const terminal = room.ownedTerminals?.[0] ?? null;
        return {
          bands: [...policy.bands],
          commitments: [...policy.commitments],
          controllerLevel: room.controller.level,
          extractor:
            extractor === null ? null : { active: extractor.active, cooldown: extractor.cooldown },
          mineral:
            room.mineral === null || room.mineral === undefined
              ? null
              : {
                  amount: room.mineral.amount ?? 0,
                  id: room.mineral.id,
                  pos: room.mineral.pos,
                  resourceType: room.mineral.mineralType,
                  ticksToRegeneration: room.mineral.ticksToRegeneration ?? null,
                },
          protectedEnergy: policy.protectedEnergy,
          roomName: room.name,
          storage:
            storage === null
              ? null
              : {
                  active: storage.active,
                  freeCapacity: storage.store.freeCapacity ?? 0,
                  stocks: storage.store.resources.map(({ amount, resourceType }) => ({
                    amount,
                    resourceType,
                  })),
                },
          terminal:
            terminal === null
              ? null
              : {
                  active: terminal.active,
                  cooldown: terminal.cooldown,
                  freeCapacity: terminal.store.freeCapacity ?? 0,
                  stocks: terminal.store.resources.map(({ amount, resourceType }) => ({
                    amount,
                    resourceType,
                  })),
                },
        };
      })
      .filter((room): room is IndustryRoomState => room !== null)
      .sort((a, b) => a.roomName.localeCompare(b.roomName)),
  );
}

export function projectIndustryBudgets(plan: IndustryPlan, tick: number): readonly BudgetRequest[] {
  return freeze([
    ...plan.extraction.map((proposal): BudgetRequest => ({
      category: "industry",
      colonyId: proposal.roomName,
      issuer: proposal.identity,
      revision: 1,
      expiresAt: safeAdd(tick, 20),
      energy: { minimum: 300, desired: 800 },
      cpu: { minimum: 0.1, desired: 0.5 },
      spawn: null,
    })),
    ...plan.sends.map((proposal): BudgetRequest => ({
      category: "industry",
      colonyId: proposal.sourceRoom,
      issuer: proposal.identity,
      revision: 1,
      expiresAt: proposal.deadline,
      energy: {
        minimum: proposal.transactionEnergy,
        desired: proposal.transactionEnergy,
      },
      cpu: { minimum: 0.02, desired: 0.1 },
      spawn: null,
    })),
  ]);
}

export function authorizeIndustryWork(input: {
  readonly plan: IndustryPlan;
  readonly reservations: readonly LedgerEntry[];
  readonly rooms: readonly IndustryRoomState[];
  readonly tick: number;
}): IndustryAuthorization {
  const budgets = projectIndustryBudgets(input.plan, input.tick);
  const extractionContracts: WorkContractRequest[] = [];
  for (const proposal of input.plan.extraction) {
    const request = budgets.find(({ issuer }) => issuer === proposal.identity);
    const reservation = input.reservations.find(
      ({ category, colonyId, issuer, status }) =>
        status === "active" &&
        category === "industry" &&
        colonyId === proposal.roomName &&
        issuer === proposal.identity,
    );
    const room = input.rooms.find(({ roomName }) => roomName === proposal.roomName);
    const target = room?.mineral;
    if (
      request === undefined ||
      reservation === undefined ||
      target === null ||
      target === undefined ||
      target.pos === undefined
    )
      continue;
    extractionContracts.push({
      budgetBinding: { category: "industry", issuer: request.issuer },
      conditions: {
        cancellation: `industry/${proposal.roomName}/stock-limit`,
        failure: `industry/${proposal.roomName}/mineral-unavailable`,
        success: `industry/${proposal.roomName}/target-or-depleted`,
      },
      deadline: safeAdd(input.tick, 1_500),
      execution: {
        action: "harvest",
        completion: "target-depleted",
        counterpartId: null,
        resourceType: proposal.resourceType as ResourceConstant,
        version: 1,
      },
      earliestStart: input.tick,
      estimatedWorkTicks: Math.max(1, Math.ceil(proposal.amount / 2)),
      expiresAt: safeAdd(input.tick, 1_501),
      issuer: proposal.identity,
      issuerKey: `${proposal.roomName}/${proposal.mineralId}`,
      issuerSequence: 1,
      kind: "harvest",
      leasePolicy: { duration: 25, switchingPenalty: 10, ttlSafetyMargin: 50 },
      maxAssignmentCost: 100,
      owner: { id: proposal.roomName, kind: "colony" },
      preconditionKeys: [`mineral/${proposal.mineralId}/available`],
      priority: { class: "speculation", value: 200 },
      quantity: proposal.amount,
      range: 1,
      requiredCapability: {
        attack: 0,
        carry: 0,
        claim: 0,
        heal: 0,
        move: 1,
        rangedAttack: 0,
        tough: 0,
        work: 1,
      },
      target: target.pos,
      targetId: proposal.mineralId,
    });
  }
  return freeze({ budgets, extractionContracts });
}

function safeAdd(value: number, delta: number): number {
  return value <= Number.MAX_SAFE_INTEGER - delta ? value + delta : Number.MAX_SAFE_INTEGER;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
