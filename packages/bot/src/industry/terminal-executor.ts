import {
  executeAcceptedIntentBatch,
  type ArbitrationBatch,
  type CommandCpuMeter,
  type CommandExecutionResult,
  type IntentEnvelope,
} from "../execution";
import type { LedgerEntry } from "../colony";
import type { IndustryPlan, TerminalSendProposal } from "./stock-policy";

export type TerminalSendIntent = IntentEnvelope<
  "terminal.send",
  {
    readonly amount: number;
    readonly destinationRoom: string;
    readonly requestId: string;
    readonly resourceType: string;
    readonly terminalId: string;
    readonly transactionEnergy: number;
  }
>;

export interface TerminalSendCommand {
  readonly amount: number;
  readonly destinationRoom: string;
  readonly resourceType: string;
  readonly terminalId: string;
}

export function projectTerminalSendIntents(input: {
  readonly plan: IndustryPlan;
  readonly reservations: readonly LedgerEntry[];
  readonly terminalIds: ReadonlyMap<string, string>;
  readonly tick: number;
}): readonly TerminalSendIntent[] {
  return Object.freeze(
    input.plan.sends.flatMap((proposal) => {
      const terminalId = input.terminalIds.get(proposal.sourceRoom);
      const funded = input.reservations.some(
        ({ category, colonyId, issuer, status }) =>
          status === "active" &&
          category === "industry" &&
          colonyId === proposal.sourceRoom &&
          issuer === proposal.identity,
      );
      if (terminalId === undefined || !funded) return [];
      return [terminalIntent(proposal, terminalId, input.tick)];
    }),
  );
}

export function executeTerminalSendIntents(
  arbitration: ArbitrationBatch<"terminal.send", TerminalSendIntent["payload"]>,
  tick: number,
  resolveTerminal: (id: string) => StructureTerminal | null,
  cpu?: CommandCpuMeter,
): readonly CommandExecutionResult<TerminalSendCommand>[] {
  return executeAcceptedIntentBatch({
    arbitration,
    tick,
    commandFor: (intent) => ({
      amount: intent.payload.amount,
      destinationRoom: intent.payload.destinationRoom,
      resourceType: intent.payload.resourceType,
      terminalId: intent.payload.terminalId,
    }),
    adapter: {
      issue: (command) => {
        const terminal = resolveTerminal(command.terminalId);
        if (terminal === null) return -7;
        return terminal.send(
          command.resourceType as ResourceConstant,
          command.amount,
          command.destinationRoom,
        );
      },
    },
    ...(cpu === undefined ? {} : { cpu }),
  });
}

function terminalIntent(
  proposal: TerminalSendProposal,
  terminalId: string,
  tick: number,
): TerminalSendIntent {
  return Object.freeze({
    id: proposal.identity,
    kind: "terminal.send",
    issuer: `industry/${proposal.sourceRoom}`,
    tick,
    target: proposal.destinationRoom,
    snapshotRevision: `industry:${String(tick)}`,
    exclusiveResourceKey: `terminal/${terminalId}`,
    priority: { class: "speculation" as const, value: 200 },
    deadline: proposal.deadline,
    budget: {
      id: proposal.identity,
      cost: proposal.transactionEnergy + (proposal.resourceType === "energy" ? proposal.amount : 0),
    },
    preconditions: [],
    payload: {
      amount: proposal.amount,
      destinationRoom: proposal.destinationRoom,
      requestId: proposal.requestId,
      resourceType: proposal.resourceType,
      terminalId,
      transactionEnergy: proposal.transactionEnergy,
    },
  });
}
