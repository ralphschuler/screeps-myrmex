import type { ColonyRclUnlockAllowances } from "../colony";
import type { LayoutLayer } from "./contracts";

export interface LayoutV1Cell {
  readonly dx: number;
  readonly dy: number;
  readonly layer: LayoutLayer;
  readonly minimumRcl: number;
  readonly structureType: string;
}
const ORDER: readonly [keyof ColonyRclUnlockAllowances, string, number][] = [
  ["spawns", "spawn", 1],
  ["storage", "storage", 4],
  ["terminal", "terminal", 6],
  ["towers", "tower", 3],
  ["links", "link", 5],
  ["containers", "container", 2],
  ["labs", "lab", 6],
  ["extractor", "extractor", 6],
  ["factory", "factory", 7],
  ["observer", "observer", 8],
  ["powerSpawn", "powerSpawn", 8],
  ["nuker", "nuker", 8],
  ["extensions", "extension", 2],
];

export function compileOwnedRoomLayoutV1(
  unlocks: ColonyRclUnlockAllowances,
  sourceServiceSlots = 0,
): readonly LayoutV1Cell[] {
  const offsets = spiralOffsets();
  const cells: LayoutV1Cell[] = [];
  let cursor = 0;
  for (const [field, structureType, minimumRcl] of ORDER) {
    const available = typeof unlocks[field] === "number" ? unlocks[field] : 0;
    const count = field === "containers" ? Math.max(0, available - sourceServiceSlots) : available;
    for (let index = 0; index < count; index += 1) {
      const offset = offsets[cursor++];
      if (offset === undefined) break;
      cells.push({ ...offset, layer: "primary", minimumRcl, structureType });
    }
    if (field === "containers") cursor += Math.min(sourceServiceSlots, available);
  }
  for (let delta = -8; delta <= 8; delta += 1) {
    cells.push({ dx: delta, dy: 0, layer: "road", minimumRcl: 2, structureType: "road" });
    if (delta !== 0)
      cells.push({ dx: 0, dy: delta, layer: "road", minimumRcl: 2, structureType: "road" });
  }
  if (unlocks.ramparts) {
    for (const cell of cells.filter(
      (item) =>
        item.layer === "primary" && ["spawn", "storage", "tower"].includes(item.structureType),
    )) {
      cells.push({ ...cell, layer: "rampart", structureType: "rampart" });
    }
  }
  return cells;
}

function spiralOffsets(): readonly { readonly dx: number; readonly dy: number }[] {
  const values: { dx: number; dy: number }[] = [{ dx: 0, dy: 0 }];
  for (let radius = 1; radius <= 8; radius += 1) {
    for (let dy = -radius; dy <= radius; dy += 1)
      for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === radius && dx !== 0 && dy !== 0)
          values.push({ dx, dy });
      }
  }
  return values;
}
