import type { RuntimeGame } from "../runtime/context";
import type { WorldSnapshot } from "./snapshot";

export function observeWorld(game: RuntimeGame): WorldSnapshot {
  const ownedRooms = Object.values(game.rooms)
    .filter((room) => room.controller?.my === true)
    .map((room) => ({
      energyAvailable: room.energyAvailable,
      energyCapacityAvailable: room.energyCapacityAvailable,
      name: room.name,
      rcl: room.controller?.level ?? 0,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    observedAt: game.time,
    ownedRooms,
  };
}
