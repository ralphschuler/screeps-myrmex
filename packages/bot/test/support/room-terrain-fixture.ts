const ROOM_SIZE = 50;
const PLAIN_TERRAIN_CELLS = new Uint8Array(ROOM_SIZE * ROOM_SIZE);

export const PLAIN_ROOM_TERRAIN = Object.freeze({
  get: (x: number, y: number) => PLAIN_TERRAIN_CELLS[y * ROOM_SIZE + x] ?? 0,
}) as unknown as RoomTerrain;
