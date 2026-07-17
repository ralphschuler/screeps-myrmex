import type { BudgetRequest, LedgerEntry } from "../colony";
import type { StaticMiningPlan } from "../economy";
import type { GrowthCandidate } from "../growth";
import type { LogisticsRuntimeProjection } from "../logistics/runtime";
import type { RoomSnapshot } from "../world/snapshot";
import { arbitrateLinkTransfers, classifyLinks, deriveLinkRoleAnchors } from "./arbiter";
import type {
  ClassifiedLink,
  LinkLayoutEvidence,
  LinkRoomRuntimeResult,
  LinkRuntimeResult,
  LinkTransferProposal,
} from "./contracts";

export interface LinkRoomLayoutEvidence {
  readonly evidence: LinkLayoutEvidence;
  readonly roomName: string;
}

export function emptyLinkRuntimeResult(
  status: LinkRuntimeResult["status"] = "not-run",
): LinkRuntimeResult {
  return freeze({ execution: [], rooms: [], status });
}

/** Projects funded link transfers without owning layout, budgets, or live commands. */
export function planLinkRuntime(input: {
  readonly growth: readonly GrowthCandidate[];
  readonly layouts: readonly LinkRoomLayoutEvidence[];
  readonly logistics: LogisticsRuntimeProjection;
  readonly mining: StaticMiningPlan;
  readonly reservations: readonly LedgerEntry[];
  readonly rooms: readonly RoomSnapshot[];
  readonly tick: number;
}): LinkRuntimeResult {
  const rooms: LinkRoomRuntimeResult[] = [];
  for (const layout of [...input.layouts].sort((a, b) => a.roomName.localeCompare(b.roomName))) {
    const room = input.rooms.find(({ name }) => name === layout.roomName);
    if (room?.controller?.ownership !== "owned") continue;
    const layoutRevision = `${layout.evidence.algorithmRevision}:${layout.evidence.fingerprint}`;
    const anchors = deriveLinkRoleAnchors(layout.evidence);
    const classification = classifyLinks({
      anchors,
      layoutRevision,
      links: (room.ownedLinks ?? []).map((link) => ({
        active: link.active,
        cooldown: link.cooldown,
        energy:
          link.store.resources.find(({ resourceType }) => resourceType === "energy")?.amount ?? 0,
        freeCapacity: link.store.freeCapacity ?? 0,
        id: link.id,
        observedAt: room.observedAt,
        owned: true,
        pos: link.pos,
      })),
      tick: input.tick,
    });
    const proposals = proposalsForRoom({
      ...input,
      links: classification.links,
      room,
      layoutRevision,
    });
    rooms.push({
      arbitration: arbitrateLinkTransfers({
        layoutRevision,
        links: classification.links,
        proposals,
        tick: input.tick,
      }),
      classification,
      layoutRevision,
      roomName: room.name,
    });
  }
  return freeze({ execution: [], rooms, status: "planned" });
}

function proposalsForRoom(input: {
  readonly growth: readonly GrowthCandidate[];
  readonly layoutRevision: string;
  readonly links: readonly ClassifiedLink[];
  readonly logistics: LogisticsRuntimeProjection;
  readonly mining: StaticMiningPlan;
  readonly reservations: readonly LedgerEntry[];
  readonly room: RoomSnapshot;
  readonly tick: number;
}): readonly LinkTransferProposal[] {
  const proposals: LinkTransferProposal[] = [];
  const hub = input.links.find(({ role }) => role === "hub");
  const controller = input.links.find(({ role }) => role === "controller");
  const controllerFunding = input.growth
    .filter(
      ({ action, colonyId }) => action === "upgrade-controller" && colonyId === input.room.name,
    )
    .map(({ budgetRequest, reasonCode }) => ({
      request: budgetRequest,
      priorityClass: reasonCode === "controller-risk" ? ("survival" as const) : ("growth" as const),
      priorityValue: reasonCode === "controller-risk" ? 900 : 100,
    }))
    .find(({ request }) => activeReservation(input.reservations, request) !== undefined);
  const logisticsFunding = input.logistics.budgets
    .filter(({ colonyId }) => colonyId === input.room.name)
    .find((request) => activeReservation(input.reservations, request) !== undefined);

  for (const source of input.links.filter(({ role }) => role === "source")) {
    const projection = input.mining.projections.find(
      ({ colonyId, sourceId }) => colonyId === input.room.name && sourceId === source.sourceId,
    );
    const request = projection?.budgetRequest;
    const reservation =
      request === null || request === undefined
        ? undefined
        : activeReservation(input.reservations, request);
    if (projection === undefined || reservation === undefined) continue;
    const target = hub?.freeCapacity ? hub : controller;
    if (target === undefined) continue;
    proposals.push(
      proposal({
        amount: source.energy,
        flowId: projection.identity,
        layoutRevision: input.layoutRevision,
        priorityClass: target.role === "controller" ? "survival" : "maintenance",
        priorityValue: target.role === "controller" ? 850 : 500,
        reservation,
        source,
        target,
        tick: input.tick,
      }),
    );
  }
  if (hub !== undefined && controller !== undefined && controller.freeCapacity > 0) {
    const funding = controllerFunding?.request ?? logisticsFunding;
    const reservation =
      funding === undefined ? undefined : activeReservation(input.reservations, funding);
    if (funding !== undefined && reservation !== undefined)
      proposals.push(
        proposal({
          amount: hub.energy,
          flowId: funding.issuer,
          layoutRevision: input.layoutRevision,
          priorityClass: controllerFunding?.priorityClass ?? "maintenance",
          priorityValue: controllerFunding?.priorityValue ?? 400,
          reservation,
          source: hub,
          target: controller,
          tick: input.tick,
        }),
      );
  }
  return freeze(proposals);
}

function activeReservation(reservations: readonly LedgerEntry[], request: BudgetRequest) {
  return reservations.find(
    ({ category, colonyId, issuer, status }) =>
      status === "active" &&
      category === request.category &&
      colonyId === request.colonyId &&
      issuer === request.issuer,
  );
}

function proposal(input: {
  readonly amount: number;
  readonly flowId: string;
  readonly layoutRevision: string;
  readonly priorityClass: "survival" | "maintenance" | "growth";
  readonly priorityValue: number;
  readonly reservation: LedgerEntry;
  readonly source: ClassifiedLink;
  readonly target: ClassifiedLink;
  readonly tick: number;
}): LinkTransferProposal {
  const id = `links/${input.layoutRevision}/${input.source.id}/${input.target.id}/${input.flowId}`;
  return {
    amount: input.amount,
    budget: { cost: input.amount, id: input.reservation.reservationId },
    deadline: input.tick,
    flowId: input.flowId,
    fundingStatus: "active",
    id,
    layoutRevision: input.layoutRevision,
    priority: { class: input.priorityClass, value: input.priorityValue },
    sourceLinkId: input.source.id,
    targetLinkId: input.target.id,
  };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
