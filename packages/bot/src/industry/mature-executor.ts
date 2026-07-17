import {
  executeAcceptedIntentBatch,
  type ArbitrationBatch,
  type CommandCpuMeter,
  type CommandExecutionResult,
  type IntentData,
  type IntentEnvelope,
} from "../execution";
import type { MatureCommandIntent, MatureFactoryProduceIntent } from "./mature-runtime";

export type MatureCommand =
  | {
      readonly batchAmount: number;
      readonly capabilityFingerprint: string;
      readonly components: MatureFactoryProduceIntent["payload"]["components"];
      readonly factoryLevel: number | null;
      readonly kind: "factory-produce";
      readonly mechanicsFingerprint: string;
      readonly operateFactoryPower: number;
      readonly product: string;
      readonly resourcesBefore: MatureFactoryProduceIntent["payload"]["resourcesBefore"];
      readonly storeCapacity: number;
      readonly storeUsedBefore: number;
      readonly structureId: string;
    }
  | {
      readonly capabilityFingerprint: string;
      readonly energyBefore: number;
      readonly energyPerPower: number;
      readonly kind: "power-process";
      readonly mechanicsFingerprint: string;
      readonly operatePowerEffect: number;
      readonly operatePowerLevel: number;
      readonly operatePowerPower: number;
      readonly powerBefore: number;
      readonly structureId: string;
      readonly units: number;
    };

export interface MatureExecutionAdapter {
  readonly currentCapabilityFingerprint: (
    kind: "factory" | "power-spawn",
    id: string,
  ) => string | null;
  readonly currentMechanicsFingerprint: () => string | null;
  readonly resolveFactory: (id: string) => StructureFactory | null;
  readonly resolvePowerSpawn: (id: string) => StructurePowerSpawn | null;
}

/** Sole boundary for accepted StructureFactory and StructurePowerSpawn mature commands. */
export function executeMatureIntents(
  arbitration: ArbitrationBatch,
  tick: number,
  adapter: MatureExecutionAdapter,
  cpu?: CommandCpuMeter,
): readonly CommandExecutionResult<MatureCommand>[] {
  const accepted = arbitration.accepted.filter(isMatureCommandIntent);
  return executeAcceptedIntentBatch<
    MatureCommand,
    MatureCommandIntent["kind"],
    MatureCommandIntent["payload"]
  >({
    arbitration: { ...arbitration, accepted, decisions: [] },
    tick,
    commandFor: (intent) => commandForIntent(intent as MatureCommandIntent),
    adapter: { issue: (command) => issueMatureCommand(command, adapter) },
    ...(cpu === undefined ? {} : { cpu }),
  });
}

function commandForIntent(intent: MatureCommandIntent): MatureCommand {
  return intent.kind === "factory.produce"
    ? Object.freeze({
        batchAmount: intent.payload.batchAmount,
        capabilityFingerprint: intent.payload.capabilityFingerprint,
        components: intent.payload.components,
        factoryLevel: intent.payload.factoryLevel,
        kind: "factory-produce" as const,
        mechanicsFingerprint: intent.payload.mechanicsFingerprint,
        operateFactoryPower: intent.payload.operateFactoryPower,
        product: intent.payload.product,
        resourcesBefore: intent.payload.resourcesBefore,
        storeCapacity: intent.payload.storeCapacity,
        storeUsedBefore: intent.payload.storeUsedBefore,
        structureId: intent.payload.structureId,
      })
    : Object.freeze({
        capabilityFingerprint: intent.payload.capabilityFingerprint,
        energyBefore: intent.payload.energyBefore,
        energyPerPower: intent.payload.energyPerPower,
        kind: "power-process" as const,
        mechanicsFingerprint: intent.payload.mechanicsFingerprint,
        operatePowerEffect: intent.payload.operatePowerEffect,
        operatePowerLevel: intent.payload.operatePowerLevel,
        operatePowerPower: intent.payload.operatePowerPower,
        powerBefore: intent.payload.powerBefore,
        structureId: intent.payload.structureId,
        units: intent.payload.units,
      });
}

function issueMatureCommand(command: MatureCommand, adapter: MatureExecutionAdapter): number {
  if (adapter.currentMechanicsFingerprint() !== command.mechanicsFingerprint) return -7;
  return command.kind === "factory-produce"
    ? issueFactoryCommand(command, adapter)
    : issuePowerCommand(command, adapter);
}

function issueFactoryCommand(
  command: Extract<MatureCommand, { kind: "factory-produce" }>,
  adapter: MatureExecutionAdapter,
): number {
  const factory = adapter.resolveFactory(command.structureId);
  if (
    adapter.currentCapabilityFingerprint("factory", command.structureId) !==
      command.capabilityFingerprint ||
    factory === null ||
    !factory.my ||
    !factory.isActive() ||
    factory.room.controller?.my !== true ||
    factory.room.controller.level < 7 ||
    factory.cooldown !== 0 ||
    (factory.level ?? null) !== command.factoryLevel ||
    !factoryEffectsMatch(factory, command) ||
    factory.store.getUsedCapacity() !== command.storeUsedBefore ||
    factory.store.getCapacity() !== command.storeCapacity ||
    command.resourcesBefore.some(
      ({ amount, resourceType }) =>
        factory.store.getUsedCapacity(resourceType as ResourceConstant) !== amount,
    ) ||
    command.components.some(
      ({ amount, resourceType }) =>
        factory.store.getUsedCapacity(resourceType as ResourceConstant) < amount,
    ) ||
    !factoryOutputFits(command)
  )
    return -7;
  return factory.produce(command.product as CommodityConstant);
}

function factoryEffectsMatch(
  factory: StructureFactory,
  command: Extract<MatureCommand, { kind: "factory-produce" }>,
): boolean {
  if (command.factoryLevel === null) return true;
  const effects = (factory.effects ?? []).filter(
    (effect) =>
      effect.effect === command.operateFactoryPower &&
      effect.ticksRemaining > 0 &&
      "level" in effect,
  );
  return effects.length === 1 && powerEffectLevel(effects[0]) === command.factoryLevel;
}

function factoryOutputFits(command: Extract<MatureCommand, { kind: "factory-produce" }>): boolean {
  const consumed = command.components.reduce((total, { amount }) => total + amount, 0);
  return (
    command.batchAmount > 0 &&
    command.storeUsedBefore - consumed + command.batchAmount <= command.storeCapacity
  );
}

function issuePowerCommand(
  command: Extract<MatureCommand, { kind: "power-process" }>,
  adapter: MatureExecutionAdapter,
): number {
  const powerSpawn = adapter.resolvePowerSpawn(command.structureId);
  if (
    adapter.currentCapabilityFingerprint("power-spawn", command.structureId) !==
      command.capabilityFingerprint ||
    powerSpawn === null ||
    !powerSpawn.my ||
    !powerSpawn.isActive() ||
    powerSpawn.room.controller?.my !== true ||
    powerSpawn.room.controller.level < 8 ||
    powerSpawn.store.getUsedCapacity("power") !== command.powerBefore ||
    powerSpawn.store.getUsedCapacity("energy") !== command.energyBefore ||
    command.powerBefore < command.units ||
    command.energyBefore < command.units * command.energyPerPower ||
    livePowerLevel(powerSpawn, command.operatePowerPower) !== command.operatePowerLevel ||
    command.units !== 1 + command.operatePowerEffect
  )
    return -7;
  return powerSpawn.processPower();
}

function livePowerLevel(powerSpawn: StructurePowerSpawn, operatePowerPower: number): number {
  const effects = (powerSpawn.effects ?? []).filter(
    (effect) =>
      effect.effect === operatePowerPower && effect.ticksRemaining > 0 && "level" in effect,
  );
  if (effects.length > 1) return -1;
  const level = effects.length === 0 ? 0 : powerEffectLevel(effects[0]);
  return Number.isSafeInteger(level) && Number(level) >= 0 && Number(level) <= 5
    ? Number(level)
    : -1;
}

function powerEffectLevel(effect: RoomObjectEffect | undefined): number | null {
  return effect !== undefined && "level" in effect && typeof effect.level === "number"
    ? effect.level
    : null;
}

function isMatureCommandIntent(intent: IntentEnvelope): intent is MatureCommandIntent {
  if (
    intent.payload === null ||
    typeof intent.payload !== "object" ||
    Array.isArray(intent.payload)
  )
    return false;
  const payload = intent.payload as Readonly<Record<string, IntentData>>;
  return (
    (intent.kind === "factory.produce" &&
      typeof payload["structureId"] === "string" &&
      typeof payload["product"] === "string" &&
      Array.isArray(payload["components"])) ||
    (intent.kind === "power-spawn.process-power" &&
      typeof payload["structureId"] === "string" &&
      typeof payload["units"] === "number")
  );
}
