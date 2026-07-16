import {
  executeAcceptedIntentBatch,
  type ArbitrationBatch,
  type IntentEnvelope,
} from "../execution";
import type { CommandCpuMeter } from "../execution";
import type { DefenseIntentKind } from "./director";

type LiveTower = {
  attack(target: unknown): number;
  heal(target: unknown): number;
  repair(target: unknown): number;
};

type LiveController = { activateSafeMode(): number };

/** Sole live-command boundary for tower and controller safety intents. */
export function executeDefenseIntents(
  batch: ArbitrationBatch,
  tick: number,
  resolveObject: (id: string) => unknown,
  cpu: CommandCpuMeter,
): void {
  const accepted = batch.accepted.filter(isDefenseIntent);
  if (accepted.length === 0) return;
  const defenseBatch: ArbitrationBatch<DefenseIntentKind> = Object.freeze({
    tick: batch.tick,
    submitted: accepted.length,
    acceptedBudget: accepted.reduce((total, intent) => total + intent.budget.cost, 0),
    accepted: Object.freeze(accepted),
    decisions: Object.freeze([]),
  });
  executeAcceptedIntentBatch({
    tick,
    arbitration: defenseBatch,
    commandFor: (intent) => intent,
    adapter: { issue: (intent) => issueDefenseCommand(intent, resolveObject) },
    cpu,
  });
}

function isDefenseIntent(intent: IntentEnvelope): intent is IntentEnvelope<DefenseIntentKind> {
  return (
    intent.kind === "tower.attack" ||
    intent.kind === "tower.heal" ||
    intent.kind === "tower.repair" ||
    intent.kind === "safe-mode"
  );
}

function issueDefenseCommand(
  intent: IntentEnvelope<DefenseIntentKind>,
  resolveObject: (id: string) => unknown,
): number {
  if (intent.kind === "safe-mode") {
    const controller = resolveObject(intent.target);
    return isLiveController(controller) ? controller.activateSafeMode() : -7;
  }
  const towerId = towerIdFor(intent as IntentEnvelope<Exclude<DefenseIntentKind, "safe-mode">>);
  const tower = towerId === null ? null : resolveObject(towerId);
  const target = resolveObject(intent.target);
  if (!isLiveTower(tower) || target === null) return -7;
  return intent.kind === "tower.attack"
    ? tower.attack(target)
    : intent.kind === "tower.heal"
      ? tower.heal(target)
      : tower.repair(target);
}

function towerIdFor(
  intent: IntentEnvelope<Exclude<DefenseIntentKind, "safe-mode">>,
): string | null {
  const payload = intent.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = (payload as { readonly towerId?: unknown }).towerId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isLiveTower(value: unknown): value is LiveTower {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { attack?: unknown }).attack === "function" &&
    typeof (value as { heal?: unknown }).heal === "function" &&
    typeof (value as { repair?: unknown }).repair === "function"
  );
}

function isLiveController(value: unknown): value is LiveController {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { activateSafeMode?: unknown }).activateSafeMode === "function"
  );
}
