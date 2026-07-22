import type {
  ConstructionSiteSnapshot,
  PositionSnapshot,
  StructureSnapshot,
} from "../world/snapshot";
import { isObservedStructureStaticallyWalkable } from "../world/traversal";

export function isLayoutAccessWalkableType(structureType: string): boolean {
  return structureType === "container" || structureType === "road" || structureType === "rampart";
}

export function isObservedLayoutAccessWalkable(structure: StructureSnapshot): boolean {
  return isObservedStructureStaticallyWalkable(
    structure.structureType,
    structure.ownership,
    structure.isPublic,
  );
}

export function isFutureLayoutAccessWalkable(site: ConstructionSiteSnapshot): boolean {
  return (
    site.structureType === "container" ||
    site.structureType === "road" ||
    (site.structureType === "rampart" && site.ownership === "owned")
  );
}

export function isLegalSourceWorkCoordinate(position: PositionSnapshot): boolean {
  return position.x > 0 && position.x < 49 && position.y > 0 && position.y < 49;
}
