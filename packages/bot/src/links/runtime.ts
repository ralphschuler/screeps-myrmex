import type { BudgetRequest, ColonyDomainHealthStatus, LedgerEntry } from "../colony";
import type { StaticMiningPlan } from "../economy";
import type { GrowthCandidate } from "../growth";
import type { LogisticsRuntimeProjection } from "../logistics/runtime";
import type { RoomSnapshot } from "../world/snapshot";
import { arbitrateLinkTransfers, classifyLinks, deriveLinkRoleAnchors } from "./arbiter";
import type {
  ClassifiedLink,
  LinkClassificationResult,
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
  readonly excludedLinkIds?: ReadonlySet<string>;
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
    const { classification, layoutRevision } = classifyRoomLinks(layout.evidence, room, input.tick);
    const excludedLinkIds = validExcludedLinkIds(input.excludedLinkIds)
      ? input.excludedLinkIds
      : new Set(classification.links.map(({ id }) => id));
    const proposals = proposalsForRoom({
      ...input,
      links: classification.links.filter(({ id }) => !excludedLinkIds?.has(id)),
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

export function validateReserveLinkEvacuationContinuity(input: {
  readonly candidates: readonly {
    readonly id: string;
    readonly replacementId: string;
    readonly roomName: string;
    readonly sourceId: string;
  }[];
  readonly layouts: readonly LinkRoomLayoutEvidence[];
  readonly rooms: readonly RoomSnapshot[];
  readonly tick: number;
}): readonly string[] {
  if (input.candidates.length > 64) return Object.freeze([]);
  const candidateIds = new Set(input.candidates.map(({ id }) => id));
  if (
    candidateIds.size !== input.candidates.length ||
    input.candidates.some(
      ({ id, replacementId, roomName, sourceId }) =>
        id.length === 0 ||
        id.length > 128 ||
        replacementId.length === 0 ||
        replacementId.length > 128 ||
        roomName.length === 0 ||
        roomName.length > 16 ||
        sourceId.length === 0 ||
        sourceId.length > 128 ||
        sourceId === replacementId,
    )
  )
    return Object.freeze([]);
  const authorized: string[] = [];
  for (const candidate of [...input.candidates].sort((a, b) => a.id.localeCompare(b.id))) {
    const layouts = input.layouts.filter(({ roomName }) => roomName === candidate.roomName);
    const layout = layouts[0];
    const room = input.rooms.find(({ name }) => name === candidate.roomName);
    if (
      layouts.length !== 1 ||
      layout === undefined ||
      room?.controller?.ownership !== "owned" ||
      room.controller.level !== 8 ||
      room.observedAt !== input.tick ||
      room.ownedLinks?.length !== 6 ||
      layout.evidence.linkPlacements.length !== 6 ||
      layout.evidence.sourceServices.length !== room.sources.length
    )
      continue;
    const sourceIds = new Set(room.sources.map(({ id }) => id));
    if (
      new Set(layout.evidence.sourceServices.map(({ sourceId }) => sourceId)).size !==
        layout.evidence.sourceServices.length ||
      layout.evidence.sourceServices.some(({ sourceId }) => !sourceIds.has(sourceId))
    )
      continue;
    const anchors = deriveLinkRoleAnchors(layout.evidence);
    if (
      anchors.length !== 6 ||
      anchors.filter(({ role }) => role === "source").length !== room.sources.length ||
      anchors.filter(({ role }) => role === "hub").length !== 1 ||
      anchors.filter(({ role }) => role === "controller").length !== 1
    )
      continue;
    const target = room.ownedLinks.find(({ id }) => id === candidate.sourceId);
    const replacement = room.ownedLinks.find(({ id }) => id === candidate.replacementId);
    if (
      target === undefined ||
      replacement === undefined ||
      layout.evidence.linkPlacements.some(({ x, y }) => x === target.pos.x && y === target.pos.y) ||
      !layout.evidence.linkPlacements.some(
        ({ x, y }) => x === replacement.pos.x && y === replacement.pos.y,
      )
    )
      continue;
    const exactLinks = room.ownedLinks.filter((link) =>
      layout.evidence.linkPlacements.some(({ x, y }) => x === link.pos.x && y === link.pos.y),
    );
    const missingAnchors = anchors.filter(
      (anchor) => !exactLinks.some(({ pos }) => pos.x === anchor.pos.x && pos.y === anchor.pos.y),
    );
    const layoutRevision = `${layout.evidence.algorithmRevision}:${layout.evidence.fingerprint}`;
    const exactClassification = classifyLinks({
      anchors,
      layoutRevision,
      links: exactLinks.map((link) => observedLink(link, room.observedAt)),
      tick: input.tick,
    });
    if (
      exactLinks.length !== 5 ||
      missingAnchors.length !== 1 ||
      missingAnchors[0]?.role !== "reserve" ||
      exactClassification.links.length !== 5 ||
      exactClassification.truncatedLinks !== 0 ||
      exactClassification.blockers.length !== 1 ||
      exactClassification.blockers[0]?.reason !== "missing-link" ||
      exactClassification.links.find(({ id }) => id === replacement.id)?.role !== "reserve" ||
      !["source", "hub", "controller"].every((role) =>
        anchors
          .filter((anchor) => anchor.role === role)
          .every((anchor) =>
            exactClassification.links.some(
              (link) => link.anchorId === anchor.id && link.role === anchor.role,
            ),
          ),
      )
    )
      continue;
    authorized.push(candidate.id);
  }
  return Object.freeze(authorized);
}

export function projectLinkDomainHealth(input: {
  readonly layouts: readonly LinkRoomLayoutEvidence[];
  readonly rooms: readonly RoomSnapshot[];
  readonly tick: number;
}): readonly ColonyDomainHealthStatus[] {
  const statuses: ColonyDomainHealthStatus[] = [];
  for (const room of [...input.rooms]
    .filter(({ controller }) => controller?.ownership === "owned" && controller.level === 8)
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const layouts = input.layouts.filter(({ roomName }) => roomName === room.name);
    const layout = layouts[0];
    const healthy =
      layouts.length === 1 &&
      layout !== undefined &&
      linkClassificationHealthy(
        classifyRoomLinks(layout.evidence, room, input.tick).classification,
        layout.evidence.linkPlacements.length,
      );
    statuses.push({
      colonyId: room.name,
      domain: "links",
      observedAt: room.observedAt,
      status: healthy ? "healthy" : "failed",
    });
  }
  return freeze(statuses);
}

function validExcludedLinkIds(value: ReadonlySet<string> | undefined): boolean {
  return (
    value === undefined ||
    (value.size <= 128 && [...value].every((id) => id.length > 0 && id.length <= 128))
  );
}

function observedLink(link: NonNullable<RoomSnapshot["ownedLinks"]>[number], observedAt: number) {
  return {
    active: link.active,
    cooldown: link.cooldown,
    energy: link.store.resources.find(({ resourceType }) => resourceType === "energy")?.amount ?? 0,
    freeCapacity: link.store.freeCapacity ?? 0,
    id: link.id,
    observedAt,
    owned: true,
    pos: link.pos,
  };
}

function classifyRoomLinks(
  evidence: LinkLayoutEvidence,
  room: RoomSnapshot,
  tick: number,
): { readonly classification: LinkClassificationResult; readonly layoutRevision: string } {
  const layoutRevision = `${evidence.algorithmRevision}:${evidence.fingerprint}`;
  const anchors = deriveLinkRoleAnchors(evidence);
  const classification = classifyLinks({
    anchors,
    layoutRevision,
    links: (room.ownedLinks ?? []).map((link) => observedLink(link, room.observedAt)),
    tick,
  });
  return { classification, layoutRevision };
}

function linkClassificationHealthy(
  classification: LinkClassificationResult,
  expectedLinks: number,
): boolean {
  return (
    expectedLinks > 0 &&
    classification.blockers.length === 0 &&
    classification.truncatedLinks === 0 &&
    classification.links.length === expectedLinks
  );
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
