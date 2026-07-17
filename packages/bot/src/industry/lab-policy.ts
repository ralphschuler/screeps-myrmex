import type {
  LabResourceDemand,
  LabResourceDemandDisposition,
} from "../logistics/resource-demands";
import type { LabClusterAssignment, ReactionCatalog, ReactionRecipe } from "./lab-cluster";

export const LAB_POLICY_CAPS = Object.freeze({
  maximumActiveReactionChainsPerRoom: 1,
  maximumBatchAmount: 3_000,
  maximumBoostManifestsPerRoom: 4,
  maximumBoostParts: 50,
  maximumCommitments: 64,
  maximumDeadlineHorizon: 5_000,
  maximumDemands: 32,
  maximumDependencyDepth: 4,
  maximumLabsPerRoom: 10,
  maximumObjectives: 32,
  maximumRecipes: 256,
  maximumRooms: 8,
  maximumStringLength: 160,
} as const);

export interface ReactionObjective {
  readonly amount: number;
  readonly colonyId: string;
  readonly deadline: number;
  readonly direction?: "forward" | "reverse";
  readonly funded: boolean;
  readonly id: string;
  readonly industryBudgetId: string;
  readonly priority: number;
  readonly product: string;
  readonly revision: number;
}

export interface BoostManifest {
  readonly colonyId: string;
  readonly compound: string;
  readonly creepFingerprint: string;
  readonly creepId: string;
  readonly deadline: number;
  readonly funded: boolean;
  readonly id: string;
  readonly industryBudgetId: string;
  readonly partCount: number;
  readonly partType: string;
  readonly priority: number;
  readonly revision: number;
}

export interface LabPolicyStock {
  readonly amount: number;
  readonly protectedAmount: number;
  readonly resourceType: string;
}

export interface LabPolicyLabObservation {
  readonly active: boolean;
  readonly id: string;
  readonly mineralAmount: number;
  readonly mineralType: string | null;
}

export interface LabPolicyBodyPartObservation {
  readonly boost: string | null;
  readonly type: string;
}

export interface LabPolicyCreepObservation {
  readonly body: readonly LabPolicyBodyPartObservation[];
  readonly fingerprint: string;
  readonly id: string;
}

export interface LabPolicyRoomObservation {
  readonly assignment: LabClusterAssignment | null;
  readonly catalog: ReactionCatalog | null;
  readonly colonyId: string;
  readonly creeps: readonly LabPolicyCreepObservation[];
  readonly endpointId: string;
  readonly labs: readonly LabPolicyLabObservation[];
  readonly stocks: readonly LabPolicyStock[];
}

interface CommitmentBase {
  readonly assignmentFingerprint: string;
  readonly catalogFingerprint: string;
  readonly colonyId: string;
  readonly deadline: number;
  readonly objectiveFingerprint: string;
  readonly objectiveId: string;
  readonly objectiveRevision: number;
  readonly priority: number;
}

/** Persistable data only. Lab roles, stock observations, and logistics reservations are excluded. */
export interface ReactionCommitment extends CommitmentBase {
  readonly batchAmount: number;
  readonly direction?: "forward" | "reverse";
  readonly kind: "reaction";
  readonly product: string;
  readonly reagents: readonly [string, string];
  readonly settledAmount: number;
  readonly targetProduct: string;
}

/** Persistable data only. Exact body-part settlement is grouped by one manifest tuple. */
export interface BoostCommitment extends CommitmentBase {
  readonly compound: string;
  readonly creepFingerprint: string;
  readonly creepId: string;
  readonly kind: "boost";
  readonly partCount: number;
  readonly partType: string;
  readonly settledParts: number;
}

export type LabPolicyCommitment = ReactionCommitment | BoostCommitment;

export type LabPolicyCancellationReason =
  | "cap-exceeded"
  | "catalog-changed"
  | "cluster-changed"
  | "duplicate-identity"
  | "expired-deadline"
  | "inactive-lab"
  | "invalid-catalog"
  | "invalid-objective"
  | "lost-creep"
  | "missing-cluster"
  | "missing-lab"
  | "no-reaction-path"
  | "preempted"
  | "staging-failed";

export interface LabPolicyDisposition {
  readonly blockers: readonly string[];
  readonly kind: "boost" | "reaction";
  readonly objectiveId: string;
  readonly objectiveRevision: number;
  readonly reason: LabPolicyCancellationReason | null;
  readonly status: "cancelled" | "completed" | "ready" | "staging";
}

export interface LabPolicyBlocker {
  readonly identity: string;
  readonly reason: LabPolicyCancellationReason;
}

export interface LabIndustryBudgetIdentity {
  readonly colonyId: string;
  readonly demandId: string;
  readonly deadline: number;
  readonly identity: string;
  readonly priority: "mandatory" | "normal";
}

export interface LabPolicyProjection {
  readonly blockers: readonly LabPolicyBlocker[];
  readonly budgets: readonly LabIndustryBudgetIdentity[];
  readonly commitments: readonly LabPolicyCommitment[];
  readonly demands: readonly LabResourceDemand[];
  readonly dispositions: readonly LabPolicyDisposition[];
}

export interface ReconcileLabPolicyInput {
  readonly boostManifests: readonly BoostManifest[];
  readonly commitments: readonly LabPolicyCommitment[];
  readonly reactionObjectives: readonly ReactionObjective[];
  readonly rooms: readonly LabPolicyRoomObservation[];
  readonly stagingDispositions: readonly LabResourceDemandDisposition[];
  readonly tick: number;
}

type Candidate =
  | { readonly kind: "boost"; readonly value: BoostManifest }
  | { readonly kind: "reaction"; readonly value: ReactionObjective };

interface SelectedReaction {
  readonly amount: number;
  readonly recipe: ReactionRecipe;
}

/**
 * Pure bounded authority for reaction and boost staging. It emits no executable runtime object.
 */
export function reconcileLabPolicy(input: ReconcileLabPolicyInput): LabPolicyProjection {
  const blockers: LabPolicyBlocker[] = [];
  const commitments: LabPolicyCommitment[] = [];
  const demands: LabResourceDemand[] = [];
  const dispositions: LabPolicyDisposition[] = [];
  if (!validTick(input.tick)) return emptyProjection("input", "invalid-objective");
  if (
    input.rooms.length > LAB_POLICY_CAPS.maximumRooms ||
    input.reactionObjectives.length + input.boostManifests.length >
      LAB_POLICY_CAPS.maximumObjectives ||
    input.commitments.length > LAB_POLICY_CAPS.maximumCommitments
  )
    return emptyProjection("input", "cap-exceeded");

  const orderedRooms = [...input.rooms].sort((a, b) => compare(a.colonyId, b.colonyId));
  if (duplicateValues(orderedRooms.map(({ colonyId }) => colonyId)).size > 0)
    return emptyProjection("rooms", "duplicate-identity");
  const objectiveKeys = [
    ...input.reactionObjectives.map(({ id }) => id),
    ...input.boostManifests.map(({ id }) => id),
  ];
  const duplicateObjectives = duplicateValues(objectiveKeys);
  const duplicateCommitments = duplicateValues(
    input.commitments.map(({ objectiveId }) => objectiveId),
  );
  const previousById = new Map(
    [...input.commitments]
      .sort((a, b) => compareCommitments(a, b))
      .map((commitment) => [commitment.objectiveId, commitment]),
  );
  const stagingByKey = new Map<string, LabResourceDemandDisposition>();
  const duplicateStaging = duplicateValues(
    input.stagingDispositions.map(
      ({ demandId, revision }) => `${demandId}\u0000${String(revision)}`,
    ),
  );
  for (const disposition of [...input.stagingDispositions].sort(compareStaging))
    stagingByKey.set(`${disposition.demandId}\u0000${String(disposition.revision)}`, disposition);

  const candidates = canonicalCandidates(input);
  for (const room of orderedRooms) {
    const roomCandidates = candidates.filter(({ value }) => value.colonyId === room.colonyId);
    const roomProblem = validateRoom(room);
    if (roomProblem !== null) {
      for (const candidate of roomCandidates)
        cancel(candidate, roomProblem, dispositions, blockers);
      continue;
    }
    const valid: Candidate[] = [];
    for (const candidate of roomCandidates) {
      const identity = candidate.value.id;
      if (duplicateObjectives.has(identity) || duplicateCommitments.has(identity)) {
        cancel(candidate, "duplicate-identity", dispositions, blockers);
        continue;
      }
      const reason = validateCandidate(candidate, room, input.tick);
      if (reason !== null) {
        cancel(candidate, reason, dispositions, blockers);
        continue;
      }
      valid.push(candidate);
    }

    const fundedBoosts = valid
      .filter(
        (candidate): candidate is Candidate & { kind: "boost" } =>
          candidate.kind === "boost" && candidate.value.funded,
      )
      .slice(0, LAB_POLICY_CAPS.maximumBoostManifestsPerRoom);
    const fundedReactions = valid.filter(
      (candidate): candidate is Candidate & { kind: "reaction" } =>
        candidate.kind === "reaction" && candidate.value.funded,
    );
    const selected = fundedBoosts[0] ?? fundedReactions[0];
    for (const candidate of valid) {
      if (candidate !== selected) cancel(candidate, "preempted", dispositions, blockers);
    }
    if (selected === undefined) continue;

    const previous = previousById.get(selected.value.id);
    const staleReason = previousStaleReason(previous, selected, room);
    if (staleReason !== null) {
      cancel(selected, staleReason, dispositions, blockers);
      continue;
    }
    const projected =
      selected.kind === "boost"
        ? projectBoost(selected.value, room, previous)
        : projectReaction(selected.value, room, previous);
    if (projected.completed) {
      dispositions.push(disposition(selected, "completed", null, []));
      continue;
    }
    if (projected.reason !== null || projected.commitment === null) {
      cancel(selected, projected.reason ?? "invalid-objective", dispositions, blockers);
      continue;
    }
    if (demands.length + projected.demands.length > LAB_POLICY_CAPS.maximumDemands) {
      cancel(selected, "cap-exceeded", dispositions, blockers);
      continue;
    }
    const staging = stagingStatus(projected.demands, stagingByKey, duplicateStaging);
    if (staging.failed) {
      cancel(selected, "staging-failed", dispositions, blockers, staging.blockers);
      continue;
    }
    commitments.push(projected.commitment);
    demands.push(...projected.demands);
    dispositions.push(
      disposition(selected, staging.ready ? "ready" : "staging", null, staging.blockers),
    );
  }

  for (const candidate of candidates) {
    if (!orderedRooms.some(({ colonyId }) => colonyId === candidate.value.colonyId))
      cancel(candidate, "missing-cluster", dispositions, blockers);
  }
  const uniqueDispositions = uniqueBy(
    dispositions.sort(compareDispositions),
    ({ kind, objectiveId, objectiveRevision }) =>
      `${kind}:${objectiveId}:${String(objectiveRevision)}`,
  );
  const orderedDemands = freeze(demands.sort(compareDemands));
  return freeze({
    blockers: freeze(
      uniqueBy(blockers.sort(compareBlockers), (item) => `${item.identity}:${item.reason}`),
    ),
    budgets: freeze(orderedDemands.map(projectBudgetIdentity)),
    commitments: freeze(commitments.sort(compareCommitments)),
    demands: orderedDemands,
    dispositions: freeze(uniqueDispositions),
  });
}

function canonicalCandidates(input: ReconcileLabPolicyInput): Candidate[] {
  return [
    ...input.boostManifests.map((value): Candidate => ({ kind: "boost", value })),
    ...input.reactionObjectives.map((value): Candidate => ({ kind: "reaction", value })),
  ].sort(compareCandidates);
}

function validateRoom(room: LabPolicyRoomObservation): LabPolicyCancellationReason | null {
  if (
    !identity(room.colonyId, 16) ||
    !identity(room.endpointId, 128) ||
    room.labs.length > LAB_POLICY_CAPS.maximumLabsPerRoom
  )
    return "invalid-objective";
  const assignment = room.assignment;
  if (assignment === null || assignment.roomName !== room.colonyId) return "missing-cluster";
  const assignedIds = [...assignment.reagentLabIds, ...assignment.productLabIds];
  if (duplicateValues(assignedIds).size > 0) return "invalid-objective";
  if (
    duplicateValues(assignment.boostLabIds).size > 0 ||
    assignment.boostLabIds.some((labId) => !assignment.productLabIds.includes(labId))
  )
    return "invalid-objective";
  const labs = new Map(room.labs.map((lab) => [lab.id, lab]));
  for (const labId of new Set([...assignment.reagentLabIds, ...assignment.productLabIds])) {
    const lab = labs.get(labId);
    if (lab === undefined) return "missing-lab";
    if (!lab.active) return "inactive-lab";
    if (
      !nonnegativeInteger(lab.mineralAmount) ||
      (lab.mineralType !== null && !identity(lab.mineralType, 64)) ||
      lab.mineralAmount > 0 !== (lab.mineralType !== null)
    )
      return "invalid-objective";
  }
  if (!validCatalog(room.catalog)) return "invalid-catalog";
  return null;
}

function validateCandidate(
  candidate: Candidate,
  room: LabPolicyRoomObservation,
  tick: number,
): LabPolicyCancellationReason | null {
  const value = candidate.value;
  if (
    !identity(value.id) ||
    !identity(value.industryBudgetId) ||
    !identity(value.colonyId, 16) ||
    !positiveInteger(value.revision) ||
    !nonnegativeInteger(value.priority) ||
    value.deadline < tick
  )
    return value.deadline < tick ? "expired-deadline" : "invalid-objective";
  if (value.deadline - tick > LAB_POLICY_CAPS.maximumDeadlineHorizon) return "invalid-objective";
  if (candidate.kind === "reaction") {
    const objective = value as ReactionObjective;
    if (
      !identity(objective.product, 64) ||
      !positiveInteger(objective.amount, LAB_POLICY_CAPS.maximumBatchAmount)
    )
      return "invalid-objective";
  } else {
    const manifest = value as BoostManifest;
    if (
      !identity(manifest.compound, 64) ||
      !identity(manifest.creepId, 128) ||
      !identity(manifest.creepFingerprint) ||
      !identity(manifest.partType, 32) ||
      !positiveInteger(manifest.partCount, LAB_POLICY_CAPS.maximumBoostParts)
    )
      return "invalid-objective";
    const creep = room.creeps.find(({ id }) => id === manifest.creepId);
    if (creep === undefined) return "lost-creep";
    if (creep.fingerprint !== manifest.creepFingerprint) return "lost-creep";
    const matching = creep.body.filter(({ type }) => type === manifest.partType);
    const eligible = matching.filter(
      ({ boost }) => boost === null || boost === manifest.compound,
    ).length;
    if (eligible < manifest.partCount) return "invalid-objective";
  }
  return null;
}

function previousStaleReason(
  previous: LabPolicyCommitment | undefined,
  candidate: Candidate,
  room: LabPolicyRoomObservation,
): LabPolicyCancellationReason | null {
  if (previous === undefined) return null;
  if (previous.kind !== candidate.kind) return "duplicate-identity";
  if (previous.assignmentFingerprint !== room.assignment?.fingerprint) return "cluster-changed";
  if (previous.catalogFingerprint !== room.catalog?.fingerprint) return "catalog-changed";
  if (previous.objectiveFingerprint !== objectiveFingerprint(candidate))
    return "duplicate-identity";
  return null;
}

function projectReaction(
  objective: ReactionObjective,
  room: LabPolicyRoomObservation,
  previous: LabPolicyCommitment | undefined,
): {
  readonly commitment: ReactionCommitment | null;
  readonly completed: boolean;
  readonly demands: readonly LabResourceDemand[];
  readonly reason: LabPolicyCancellationReason | null;
} {
  const available = stockMap(room.stocks);
  const existing = previous?.kind === "reaction" ? previous : undefined;
  if (existing !== undefined && existing.settledAmount >= existing.batchAmount)
    return { commitment: null, completed: true, demands: [], reason: null };
  const direction = objective.direction ?? "forward";
  if (
    direction === "forward" &&
    existing === undefined &&
    (available.get(objective.product) ?? 0) >= objective.amount
  )
    return { commitment: null, completed: true, demands: [], reason: null };
  const selected =
    existing === undefined
      ? direction === "reverse"
        ? selectReverseReaction(objective, room.catalog as ReactionCatalog, available)
        : selectForwardReaction(
            objective.product,
            objective.amount - (available.get(objective.product) ?? 0),
            room.catalog as ReactionCatalog,
            available,
          )
      : selectedFromCommitment(existing, room.catalog as ReactionCatalog);
  if (selected === null)
    return { commitment: null, completed: false, demands: [], reason: "no-reaction-path" };
  const assignment = room.assignment as LabClusterAssignment;
  const commitment: ReactionCommitment = freeze({
    assignmentFingerprint: assignment.fingerprint,
    batchAmount: selected.amount,
    catalogFingerprint: (room.catalog as ReactionCatalog).fingerprint,
    colonyId: objective.colonyId,
    deadline: objective.deadline,
    ...(direction === "reverse" ? { direction } : {}),
    kind: "reaction",
    objectiveFingerprint: objectiveFingerprint({ kind: "reaction", value: objective }),
    objectiveId: objective.id,
    objectiveRevision: objective.revision,
    priority: objective.priority,
    product: selected.recipe.product,
    reagents: freeze([...selected.recipe.reagents] as [string, string]),
    settledAmount: existing?.settledAmount ?? 0,
    targetProduct: objective.product,
  });
  const demands: LabResourceDemand[] =
    direction === "reverse"
      ? reverseDemands(objective, room, assignment, selected)
      : [
          makeDemand(
            objective,
            room,
            "reagent-a",
            assignment.reagentLabIds[0],
            "fill",
            selected.recipe.reagents[0],
            selected.amount,
          ),
          makeDemand(
            objective,
            room,
            "reagent-b",
            assignment.reagentLabIds[1],
            "fill",
            selected.recipe.reagents[1],
            selected.amount,
          ),
          ...assignment.productLabIds.flatMap((labId, index) => {
            const lab = room.labs.find(({ id }) => id === labId);
            return lab?.mineralType === null || lab === undefined || lab.mineralAmount === 0
              ? []
              : [
                  makeDemand(
                    objective,
                    room,
                    `product-${String(index)}`,
                    labId,
                    "drain",
                    lab.mineralType,
                    lab.mineralAmount,
                  ),
                ];
          }),
        ];
  return { commitment, completed: false, demands: freeze(demands), reason: null };
}

function selectReverseReaction(
  objective: ReactionObjective,
  catalog: ReactionCatalog,
  available: ReadonlyMap<string, number>,
): SelectedReaction | null {
  const recipe = catalog.recipes.find(({ product }) => product === objective.product);
  const amount = Math.min(objective.amount, available.get(objective.product) ?? 0);
  return recipe === undefined || amount < 5 ? null : { amount, recipe };
}

function reverseDemands(
  objective: ReactionObjective,
  room: LabPolicyRoomObservation,
  assignment: LabClusterAssignment,
  selected: SelectedReaction,
): LabResourceDemand[] {
  const sourceLabId = assignment.productLabIds[0];
  if (sourceLabId === undefined) return [];
  const demands: LabResourceDemand[] = [
    makeDemand(
      objective,
      room,
      "reverse-source",
      sourceLabId,
      "fill",
      selected.recipe.product,
      selected.amount,
    ),
  ];
  assignment.reagentLabIds.forEach((labId, index) => {
    const lab = room.labs.find(({ id }) => id === labId);
    const expected = selected.recipe.reagents[index];
    if (lab !== undefined && lab.mineralType !== null && lab.mineralType !== expected)
      demands.push(
        makeDemand(
          objective,
          room,
          `reverse-result-${String(index)}`,
          labId,
          "drain",
          lab.mineralType,
          lab.mineralAmount,
        ),
      );
  });
  return demands;
}

function selectedFromCommitment(
  commitment: ReactionCommitment,
  catalog: ReactionCatalog,
): SelectedReaction | null {
  const recipe = catalog.recipes.find(
    ({ product, reagents }) =>
      product === commitment.product &&
      reagents[0] === commitment.reagents[0] &&
      reagents[1] === commitment.reagents[1],
  );
  return recipe === undefined
    ? null
    : { amount: commitment.batchAmount - commitment.settledAmount, recipe };
}

function projectBoost(
  manifest: BoostManifest,
  room: LabPolicyRoomObservation,
  previous: LabPolicyCommitment | undefined,
): {
  readonly commitment: BoostCommitment | null;
  readonly completed: boolean;
  readonly demands: readonly LabResourceDemand[];
  readonly reason: LabPolicyCancellationReason | null;
} {
  const creep = room.creeps.find(({ id }) => id === manifest.creepId);
  if (creep === undefined)
    return { commitment: null, completed: false, demands: [], reason: "lost-creep" };
  const observed = creep.body.filter(
    ({ boost, type }) => type === manifest.partType && boost === manifest.compound,
  ).length;
  const settled = Math.max(previous?.kind === "boost" ? previous.settledParts : 0, observed);
  if (settled >= manifest.partCount)
    return { commitment: null, completed: true, demands: [], reason: null };
  const assignment = room.assignment as LabClusterAssignment;
  const labId = assignment.boostLabIds[0];
  if (labId === undefined)
    return { commitment: null, completed: false, demands: [], reason: "missing-lab" };
  const remaining = manifest.partCount - settled;
  const commitment: BoostCommitment = freeze({
    assignmentFingerprint: assignment.fingerprint,
    catalogFingerprint: (room.catalog as ReactionCatalog).fingerprint,
    colonyId: manifest.colonyId,
    compound: manifest.compound,
    creepFingerprint: manifest.creepFingerprint,
    creepId: manifest.creepId,
    deadline: manifest.deadline,
    kind: "boost",
    objectiveFingerprint: objectiveFingerprint({ kind: "boost", value: manifest }),
    objectiveId: manifest.id,
    objectiveRevision: manifest.revision,
    partCount: manifest.partCount,
    partType: manifest.partType,
    priority: manifest.priority,
    settledParts: settled,
  });
  return {
    commitment,
    completed: false,
    demands: freeze([
      makeDemand(
        manifest,
        room,
        "boost-compound",
        labId,
        "fill",
        manifest.compound,
        remaining * 30,
      ),
      makeDemand(manifest, room, "boost-energy", labId, "fill", "energy", remaining * 20),
    ]),
    reason: null,
  };
}

export function selectForwardReaction(
  product: string,
  amount: number,
  catalog: ReactionCatalog,
  availableStock: ReadonlyMap<string, number>,
): SelectedReaction | null {
  if (!validCatalog(catalog) || !positiveInteger(amount, LAB_POLICY_CAPS.maximumBatchAmount))
    return null;
  const recipes = new Map(catalog.recipes.map((recipe) => [recipe.product, recipe]));
  const visit = (wanted: string, needed: number, depth: number): SelectedReaction | null => {
    const recipe = recipes.get(wanted);
    if (recipe === undefined || depth > LAB_POLICY_CAPS.maximumDependencyDepth) return null;
    for (const reagent of recipe.reagents) {
      const shortage = Math.max(0, needed - (availableStock.get(reagent) ?? 0));
      if (shortage === 0 || !recipes.has(reagent)) continue;
      const dependency = visit(reagent, shortage, depth + 1);
      if (dependency !== null) return dependency;
    }
    return { amount: Math.min(needed, LAB_POLICY_CAPS.maximumBatchAmount), recipe };
  };
  return visit(product, amount, 1);
}

function makeDemand(
  objective: ReactionObjective | BoostManifest,
  room: LabPolicyRoomObservation,
  suffix: string,
  labId: string,
  mode: "drain" | "fill",
  resourceType: string,
  amount: number,
): LabResourceDemand {
  const id = `lab-policy:${objective.id}:r${String(objective.revision)}:${suffix}`;
  return freeze({
    amount,
    clusterFingerprint: (room.assignment as LabClusterAssignment).fingerprint,
    colonyId: objective.colonyId,
    deadline: objective.deadline,
    endpointId: room.endpointId,
    id,
    industryBudgetId: `${objective.industryBudgetId}/demand/${suffix}`,
    labId,
    mode,
    priority: "normal",
    resourceType,
    revision: objective.revision,
  });
}

function stagingStatus(
  demands: readonly LabResourceDemand[],
  dispositions: ReadonlyMap<string, LabResourceDemandDisposition>,
  duplicates: ReadonlySet<string>,
): { readonly blockers: readonly string[]; readonly failed: boolean; readonly ready: boolean } {
  const blockers: string[] = [];
  let failed = false;
  let ready = true;
  for (const demand of demands) {
    const key = `${demand.id}\u0000${String(demand.revision)}`;
    const staged = dispositions.get(key);
    if (duplicates.has(key) || staged?.status === "blocked") {
      failed = true;
      blockers.push(demand.id);
    } else if (staged?.status !== "satisfied") {
      ready = false;
      blockers.push(demand.id);
    }
  }
  return { blockers: freeze(blockers.sort(compare)), failed, ready: ready && !failed };
}

function validCatalog(catalog: ReactionCatalog | null): catalog is ReactionCatalog {
  if (
    catalog === null ||
    !identity(catalog.fingerprint) ||
    catalog.recipes.length > LAB_POLICY_CAPS.maximumRecipes
  )
    return false;
  const products = new Set<string>();
  for (const recipe of catalog.recipes) {
    if (
      !identity(recipe.product, 64) ||
      !identity(recipe.reagents[0], 64) ||
      !identity(recipe.reagents[1], 64) ||
      !positiveInteger(recipe.cooldown, 1_000) ||
      products.has(recipe.product)
    )
      return false;
    products.add(recipe.product);
  }
  return true;
}

export function isLabPolicyCommitment(value: unknown): value is LabPolicyCommitment {
  if (
    !record(value) ||
    !identity(value.assignmentFingerprint) ||
    !identity(value.catalogFingerprint) ||
    !identity(value.colonyId, 16) ||
    !nonnegativeInteger(value.deadline) ||
    !identity(value.objectiveFingerprint) ||
    !identity(value.objectiveId) ||
    !positiveInteger(value.objectiveRevision) ||
    !nonnegativeInteger(value.priority)
  )
    return false;
  if (value.kind === "reaction") {
    return (
      positiveInteger(value.batchAmount, LAB_POLICY_CAPS.maximumBatchAmount) &&
      identity(value.product, 64) &&
      Array.isArray(value.reagents) &&
      value.reagents.length === 2 &&
      value.reagents.every((resource) => identity(resource, 64)) &&
      nonnegativeInteger(value.settledAmount) &&
      value.settledAmount <= value.batchAmount &&
      identity(value.targetProduct, 64) &&
      (value.direction === undefined ||
        value.direction === "forward" ||
        value.direction === "reverse")
    );
  }
  return (
    value.kind === "boost" &&
    identity(value.compound, 64) &&
    identity(value.creepFingerprint) &&
    identity(value.creepId, 128) &&
    positiveInteger(value.partCount, LAB_POLICY_CAPS.maximumBoostParts) &&
    identity(value.partType, 32) &&
    nonnegativeInteger(value.settledParts) &&
    value.settledParts <= value.partCount
  );
}

function stockMap(stocks: readonly LabPolicyStock[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const stock of [...stocks].sort((a, b) => compare(a.resourceType, b.resourceType))) {
    if (
      !identity(stock.resourceType, 64) ||
      !nonnegativeInteger(stock.amount) ||
      !nonnegativeInteger(stock.protectedAmount)
    )
      continue;
    result.set(stock.resourceType, Math.max(0, stock.amount - stock.protectedAmount));
  }
  return result;
}

function objectiveFingerprint(candidate: Candidate): string {
  const value = candidate.value;
  const parts =
    candidate.kind === "reaction"
      ? [
          candidate.kind,
          value.id,
          String(value.revision),
          value.colonyId,
          (value as ReactionObjective).product,
          (value as ReactionObjective).direction ?? "forward",
          String((value as ReactionObjective).amount),
          String(value.deadline),
          String(value.priority),
        ]
      : [
          candidate.kind,
          value.id,
          String(value.revision),
          value.colonyId,
          (value as BoostManifest).creepId,
          (value as BoostManifest).creepFingerprint,
          (value as BoostManifest).compound,
          (value as BoostManifest).partType,
          String((value as BoostManifest).partCount),
          String(value.deadline),
          String(value.priority),
        ];
  return fingerprint(parts);
}

function projectBudgetIdentity(demand: LabResourceDemand): LabIndustryBudgetIdentity {
  return freeze({
    colonyId: demand.colonyId,
    deadline: demand.deadline,
    demandId: demand.id,
    identity: demand.industryBudgetId,
    priority: demand.priority,
  });
}

function disposition(
  candidate: Candidate,
  status: LabPolicyDisposition["status"],
  reason: LabPolicyCancellationReason | null,
  blockers: readonly string[],
): LabPolicyDisposition {
  return freeze({
    blockers: freeze([...blockers].sort(compare)),
    kind: candidate.kind,
    objectiveId: candidate.value.id,
    objectiveRevision: candidate.value.revision,
    reason,
    status,
  });
}

function cancel(
  candidate: Candidate,
  reason: LabPolicyCancellationReason,
  dispositions: LabPolicyDisposition[],
  blockers: LabPolicyBlocker[],
  demandBlockers: readonly string[] = [],
): void {
  dispositions.push(disposition(candidate, "cancelled", reason, demandBlockers));
  blockers.push(freeze({ identity: candidate.value.id, reason }));
}

function emptyProjection(
  identityValue: string,
  reason: LabPolicyCancellationReason,
): LabPolicyProjection {
  return freeze({
    blockers: freeze([{ identity: identityValue, reason }]),
    budgets: freeze([]),
    commitments: freeze([]),
    demands: freeze([]),
    dispositions: freeze([]),
  });
}

function compareCandidates(left: Candidate, right: Candidate): number {
  const funded = Number(right.value.funded) - Number(left.value.funded);
  const kind = (left.kind === "boost" ? 0 : 1) - (right.kind === "boost" ? 0 : 1);
  return (
    compare(left.value.colonyId, right.value.colonyId) ||
    funded ||
    kind ||
    right.value.priority - left.value.priority ||
    compare(left.value.id, right.value.id) ||
    left.value.revision - right.value.revision
  );
}

function compareCommitments(left: LabPolicyCommitment, right: LabPolicyCommitment): number {
  return (
    compare(left.colonyId, right.colonyId) ||
    compare(left.objectiveId, right.objectiveId) ||
    left.objectiveRevision - right.objectiveRevision
  );
}

function compareDemands(left: LabResourceDemand, right: LabResourceDemand): number {
  return compare(left.id, right.id) || left.revision - right.revision;
}

function compareDispositions(left: LabPolicyDisposition, right: LabPolicyDisposition): number {
  return (
    compare(left.objectiveId, right.objectiveId) ||
    left.objectiveRevision - right.objectiveRevision ||
    compare(left.kind, right.kind)
  );
}

function compareStaging(
  left: LabResourceDemandDisposition,
  right: LabResourceDemandDisposition,
): number {
  return compare(left.demandId, right.demandId) || left.revision - right.revision;
}

function compareBlockers(left: LabPolicyBlocker, right: LabPolicyBlocker): number {
  return compare(left.identity, right.identity) || compare(left.reason, right.reason);
}

function duplicateValues(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return duplicates;
}

function uniqueBy<T>(values: readonly T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identityValue = key(value);
    if (seen.has(identityValue)) return false;
    seen.add(identityValue);
    return true;
  });
}

function fingerprint(parts: readonly string[]): string {
  let hash = 2_166_136_261;
  for (const part of parts) {
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    hash ^= 0xff;
    hash = Math.imul(hash, 16_777_619);
  }
  return `lab-policy-v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function identity(
  value: unknown,
  maximum: number = LAB_POLICY_CAPS.maximumStringLength,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim()
  );
}

function validTick(value: unknown): value is number {
  return nonnegativeInteger(value);
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return nonnegativeInteger(value) && value > 0 && value <= maximum;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}
