import type { TickContext } from "../runtime/context";

export function recordTickTelemetry(context: TickContext): void {
  context.state.telemetry = {
    cpuUsed: context.game.cpu.getUsed(),
    cpuBucket: context.game.cpu.bucket,
    ownedRooms: context.state.world.ownedRooms.length,
  };
}
