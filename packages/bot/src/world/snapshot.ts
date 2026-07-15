export interface OwnedRoomSnapshot {
  readonly energyAvailable: number;
  readonly energyCapacityAvailable: number;
  readonly name: string;
  readonly rcl: number;
}

export interface WorldSnapshot {
  readonly observedAt: number;
  readonly ownedRooms: readonly OwnedRoomSnapshot[];
}

export function emptyWorldSnapshot(observedAt: number): WorldSnapshot {
  return { observedAt, ownedRooms: [] };
}
