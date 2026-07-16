import type { ColonyView } from "../colony";
import type {
  ConstructionSiteSnapshot,
  MineralSnapshot,
  PositionSnapshot,
  StructureSnapshot,
  TerrainSnapshot,
} from "../world/snapshot";

export const LAYOUT_ALGORITHM_REVISION = "owned-room-layout-v1" as const;
export const LAYOUT_OWNER_SCHEMA_VERSION = 1 as const;
export const MAX_LAYOUT_ROOMS_PER_TICK = 2 as const;
export const MAX_LAYOUT_CANDIDATES = 256 as const;
export const MAX_LAYOUT_TRANSFORMS = 8 as const;
export const MAX_LAYOUT_FLOOD_CELLS = 2_500 as const;
export const MAX_LAYOUT_RECORDS = 64 as const;
export const MAX_LAYOUT_BLOCKERS = 8 as const;

export type LayoutTransform = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type LayoutLayer = "primary" | "road" | "rampart";
export type LayoutAdoption = "planned" | "exact" | "compatible-external";
export type LayoutBlocker =
  | "budget-exhausted"
  | "invalid-input"
  | "no-anchor"
  | "terrain-conflict"
  | "occupancy-conflict"
  | "access-blocked"
  | "policy-unavailable";

export interface LayoutPlacement {
  readonly adoption: LayoutAdoption;
  readonly layer: LayoutLayer;
  readonly minimumRcl: number;
  readonly pos: PositionSnapshot;
  readonly structureType: string;
}
export interface LayoutCommitment {
  readonly algorithmRevision: typeof LAYOUT_ALGORITHM_REVISION;
  readonly anchor: PositionSnapshot;
  readonly blockers: readonly LayoutBlocker[];
  readonly committedAt: number;
  readonly fingerprint: string;
  readonly transform: LayoutTransform;
}
export interface LayoutRecord extends LayoutCommitment {
  readonly roomName: string;
}
export interface LayoutsOwnerV1 {
  readonly schemaVersion: typeof LAYOUT_OWNER_SCHEMA_VERSION;
  readonly revision: number;
  readonly records: readonly LayoutRecord[];
}

export interface LayoutPlanningInput {
  readonly constructionSites: readonly ConstructionSiteSnapshot[];
  readonly controller: PositionSnapshot;
  readonly exits: readonly PositionSnapshot[];
  readonly mineral: MineralSnapshot | null;
  readonly policy: ColonyView["rclPolicy"];
  readonly priorCommitment: LayoutCommitment | null;
  readonly roomName: string;
  readonly sources: readonly PositionSnapshot[];
  readonly structures: readonly StructureSnapshot[];
  readonly terrain: TerrainSnapshot;
  readonly tick: number;
}
export type LayoutPlanningResult =
  | {
      readonly status: "complete";
      readonly commitment: LayoutCommitment;
      readonly placements: readonly LayoutPlacement[];
      readonly candidatesInspected: number;
      readonly transformsInspected: number;
      readonly floodCellsInspected: number;
    }
  | {
      readonly status: "degraded";
      readonly blocker: LayoutBlocker;
      readonly commitment: LayoutCommitment | null;
      readonly placements: readonly [];
      readonly candidatesInspected: number;
      readonly transformsInspected: number;
      readonly floodCellsInspected: number;
    };
