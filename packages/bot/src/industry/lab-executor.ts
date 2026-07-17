import {
  executeAcceptedIntentBatch,
  type ArbitrationBatch,
  type CommandCpuMeter,
  type CommandExecutionResult,
  type IntentData,
  type IntentEnvelope,
} from "../execution";
import { LAB_RUNTIME_CAPS, type LabCommandIntent } from "./lab-runtime";

export type LabCommand =
  | {
      readonly kind: "reaction";
      readonly product: string;
      readonly productLabId: string;
      readonly productMineralBefore: number;
      readonly reagentLabIds: readonly [string, string];
      readonly reagentMineralsBefore: readonly [number, number];
      readonly reagents: readonly [string, string];
    }
  | {
      readonly compound: string;
      readonly kind: "reverse-reaction";
      readonly resultLabIds: readonly [string, string];
      readonly resultMineralsBefore: readonly [number, number];
      readonly reagents: readonly [string, string];
      readonly sourceLabId: string;
      readonly sourceMineralBefore: number;
    }
  | {
      readonly bodyPartsCount: number;
      readonly compound: string;
      readonly creepFingerprint: string;
      readonly creepId: string;
      readonly energyBefore: number;
      readonly kind: "boost";
      readonly labId: string;
      readonly mineralBefore: number;
      readonly partType: string;
      readonly targetBoostedPartsBefore: number;
    };

export interface LabExecutionAdapter {
  readonly creepFingerprint: (creep: Creep) => string;
  readonly resolveCreep: (id: string) => Creep | null;
  readonly resolveLab: (id: string) => StructureLab | null;
}

export function fingerprintLiveLabCreep(creep: Creep): string {
  const types = ["attack", "carry", "claim", "heal", "move", "ranged_attack", "tough", "work"];
  const counts = new Map(types.map((type) => [type, 0]));
  const boosts = new Map<string, number>();
  for (const part of creep.body) {
    counts.set(part.type, (counts.get(part.type) ?? 0) + 1);
    if (part.boost !== undefined) {
      const key = `${part.type}/${String(part.boost)}`;
      boosts.set(key, (boosts.get(key) ?? 0) + 1);
    }
  }
  return liveFingerprint([
    creep.id,
    creep.name,
    ...types.flatMap((type) => [type, String(counts.get(type) ?? 0)]),
    ...[...boosts]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, count]) => {
        const [type = "", compound = ""] = key.split("/");
        return [type, compound, String(count)];
      }),
  ]);
}

/** Sole boundary that may translate accepted lab intents into live Screeps lab calls. */
export function executeLabIntents(
  arbitration: ArbitrationBatch,
  tick: number,
  adapter: LabExecutionAdapter,
  cpu?: CommandCpuMeter,
): readonly CommandExecutionResult<LabCommand>[] {
  const accepted = arbitration.accepted.filter(isLabCommandIntent);
  return executeAcceptedIntentBatch<
    LabCommand,
    LabCommandIntent["kind"],
    LabCommandIntent["payload"]
  >({
    arbitration: { ...arbitration, accepted, decisions: [] },
    tick,
    commandFor: (intent) => commandForIntent(intent as LabCommandIntent),
    adapter: { issue: (command) => issueLabCommand(command, adapter) },
    ...(cpu === undefined ? {} : { cpu }),
  });
}

function commandForIntent(intent: LabCommandIntent): LabCommand {
  return intent.kind === "lab.run-reaction"
    ? Object.freeze({
        kind: "reaction" as const,
        product: intent.payload.product,
        productLabId: intent.payload.productLabId,
        productMineralBefore: intent.payload.productMineralBefore,
        reagentLabIds: intent.payload.reagentLabIds,
        reagentMineralsBefore: intent.payload.reagentMineralsBefore,
        reagents: intent.payload.reagents,
      })
    : intent.kind === "lab.reverse-reaction"
      ? Object.freeze({
          compound: intent.payload.compound,
          kind: "reverse-reaction" as const,
          resultLabIds: intent.payload.resultLabIds,
          resultMineralsBefore: intent.payload.resultMineralsBefore,
          reagents: intent.payload.reagents,
          sourceLabId: intent.payload.sourceLabId,
          sourceMineralBefore: intent.payload.sourceMineralBefore,
        })
      : Object.freeze({
          bodyPartsCount: intent.payload.bodyPartsCount,
          compound: intent.payload.compound,
          creepFingerprint: intent.payload.creepFingerprint,
          creepId: intent.payload.creepId,
          energyBefore: intent.payload.energyBefore,
          kind: "boost" as const,
          labId: intent.payload.labId,
          mineralBefore: intent.payload.mineralBefore,
          partType: intent.payload.partType,
          targetBoostedPartsBefore: intent.payload.targetBoostedPartsBefore,
        });
}

function issueLabCommand(command: LabCommand, adapter: LabExecutionAdapter): number {
  return command.kind === "reaction"
    ? issueReaction(command, adapter)
    : command.kind === "reverse-reaction"
      ? issueReverseReaction(command, adapter)
      : issueBoost(command, adapter);
}

function issueReaction(
  command: Extract<LabCommand, { kind: "reaction" }>,
  adapter: LabExecutionAdapter,
): number {
  const product = adapter.resolveLab(command.productLabId);
  const reagentA = adapter.resolveLab(command.reagentLabIds[0]);
  const reagentB = adapter.resolveLab(command.reagentLabIds[1]);
  if (
    product === null ||
    reagentA === null ||
    reagentB === null ||
    product.id === reagentA.id ||
    product.id === reagentB.id ||
    reagentA.id === reagentB.id ||
    !ownedActive(product) ||
    !ownedActive(reagentA) ||
    !ownedActive(reagentB) ||
    product.cooldown !== 0 ||
    labResource(product, command.product) !== command.productMineralBefore ||
    labResource(reagentA, command.reagents[0]) !== command.reagentMineralsBefore[0] ||
    labResource(reagentB, command.reagents[1]) !== command.reagentMineralsBefore[1] ||
    reagentA.mineralType !== command.reagents[0] ||
    reagentB.mineralType !== command.reagents[1] ||
    labResource(reagentA, command.reagents[0]) < LAB_RUNTIME_CAPS.reactionAmount ||
    labResource(reagentB, command.reagents[1]) < LAB_RUNTIME_CAPS.reactionAmount ||
    (product.mineralType !== null && product.mineralType !== command.product) ||
    (product.store.getFreeCapacity(command.product as ResourceConstant) ?? 0) <
      LAB_RUNTIME_CAPS.reactionAmount ||
    product.pos.getRangeTo(reagentA.pos) > 2 ||
    product.pos.getRangeTo(reagentB.pos) > 2
  )
    return -7;
  return product.runReaction(reagentA, reagentB);
}

function issueReverseReaction(
  command: Extract<LabCommand, { kind: "reverse-reaction" }>,
  adapter: LabExecutionAdapter,
): number {
  const source = adapter.resolveLab(command.sourceLabId);
  const resultA = adapter.resolveLab(command.resultLabIds[0]);
  const resultB = adapter.resolveLab(command.resultLabIds[1]);
  if (
    source === null ||
    resultA === null ||
    resultB === null ||
    source.id === resultA.id ||
    source.id === resultB.id ||
    resultA.id === resultB.id ||
    !ownedActive(source) ||
    !ownedActive(resultA) ||
    !ownedActive(resultB) ||
    source.cooldown !== 0 ||
    source.mineralType !== command.compound ||
    labResource(source, command.compound) !== command.sourceMineralBefore ||
    labResource(source, command.compound) < LAB_RUNTIME_CAPS.reactionAmount ||
    !liveReverseResult(resultA, command.reagents[0], command.resultMineralsBefore[0]) ||
    !liveReverseResult(resultB, command.reagents[1], command.resultMineralsBefore[1]) ||
    source.pos.getRangeTo(resultA.pos) > 2 ||
    source.pos.getRangeTo(resultB.pos) > 2
  )
    return -7;
  return source.reverseReaction(resultA, resultB);
}

function issueBoost(
  command: Extract<LabCommand, { kind: "boost" }>,
  adapter: LabExecutionAdapter,
): number {
  const lab = adapter.resolveLab(command.labId);
  const creep = adapter.resolveCreep(command.creepId);
  if (
    lab === null ||
    creep === null ||
    !ownedActive(lab) ||
    creep.spawning ||
    adapter.creepFingerprint(creep) !== command.creepFingerprint ||
    lab.mineralType !== command.compound ||
    labResource(lab, command.compound) !== command.mineralBefore ||
    lab.store.getUsedCapacity("energy") !== command.energyBefore ||
    labResource(lab, command.compound) <
      command.bodyPartsCount * LAB_RUNTIME_CAPS.boostMineralPerPart ||
    lab.store.getUsedCapacity("energy") <
      command.bodyPartsCount * LAB_RUNTIME_CAPS.boostEnergyPerPart ||
    lab.pos.getRangeTo(creep.pos) > 1 ||
    boostedParts(creep, command.partType, command.compound) !== command.targetBoostedPartsBefore ||
    unboostedParts(creep, command.partType) < command.bodyPartsCount
  )
    return -7;
  return lab.boostCreep(creep, command.bodyPartsCount);
}

function ownedActive(lab: StructureLab): boolean {
  return lab.my && lab.isActive();
}
function labResource(lab: StructureLab, resource: string): number {
  return lab.store.getUsedCapacity(resource as ResourceConstant) ?? 0;
}
function liveReverseResult(lab: StructureLab, reagent: string, before: number): boolean {
  return (
    (lab.mineralType === null || lab.mineralType === reagent) &&
    labResource(lab, reagent) === before &&
    (lab.store.getFreeCapacity(reagent as ResourceConstant) ?? 0) >= LAB_RUNTIME_CAPS.reactionAmount
  );
}
function boostedParts(creep: Creep, partType: string, compound: string): number {
  return creep.body.filter(({ type, boost }) => type === partType && boost === compound).length;
}
function unboostedParts(creep: Creep, partType: string): number {
  return creep.body.filter(({ type, boost }) => type === partType && boost === undefined).length;
}
function isLabCommandIntent(intent: IntentEnvelope): intent is LabCommandIntent {
  if (
    intent.payload === null ||
    typeof intent.payload !== "object" ||
    Array.isArray(intent.payload)
  )
    return false;
  const payload = intent.payload as Readonly<Record<string, IntentData>>;
  return (
    (intent.kind === "lab.run-reaction" &&
      typeof payload["productLabId"] === "string" &&
      Array.isArray(payload["reagentLabIds"])) ||
    (intent.kind === "lab.reverse-reaction" &&
      typeof payload["sourceLabId"] === "string" &&
      Array.isArray(payload["resultLabIds"])) ||
    (intent.kind === "lab.boost-creep" &&
      typeof payload["labId"] === "string" &&
      typeof payload["creepId"] === "string")
  );
}

function liveFingerprint(parts: readonly string[]): string {
  let hash = 2_166_136_261;
  for (const part of parts)
    for (let index = 0; index < part.length; index += 1) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
  return `lab-composition-v1:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
