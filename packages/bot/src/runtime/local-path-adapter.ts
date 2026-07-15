import type { LocalPathSearch, LocalPathSearchInput, LocalPathSearchOutput } from "../movement";

/**
 * The sole adapter from detached local-path data to Screeps pathfinding globals. It returns only
 * data and never exposes engine objects to a planner.
 */
export function createScreepsLocalPathSearch(): LocalPathSearch | null {
  if (typeof PathFinder === "undefined" || typeof RoomPosition === "undefined") return null;
  const pathFinder = PathFinder;
  const position = RoomPosition;
  return Object.freeze({
    search(input: LocalPathSearchInput): LocalPathSearchOutput {
      if (input.origin.roomName !== input.goal.roomName) throw new Error("cross-room-path-search");
      if (input.staticMatrix.walkability.length !== 2_500) throw new Error("invalid-static-matrix");
      const matrix = new pathFinder.CostMatrix();
      for (let y = 0; y < 50; y += 1) {
        for (let x = 0; x < 50; x += 1) {
          if (input.staticMatrix.walkability.charAt(y * 50 + x) === "#") matrix.set(x, y, 255);
        }
      }
      const origin = new position(input.origin.x, input.origin.y, input.origin.roomName);
      const goal = new position(input.goal.x, input.goal.y, input.goal.roomName);
      const result = pathFinder.search(
        origin,
        { pos: goal, range: input.range },
        {
          maxCost: input.maxCost,
          maxOps: input.maxOps,
          roomCallback: (roomName) => (roomName === input.origin.roomName ? matrix : false),
        },
      );
      return Object.freeze({
        cost: result.cost,
        directions: Object.freeze(directionsFromPath(origin, result.path)),
        incomplete: result.incomplete,
      });
    },
  });
}

function directionsFromPath(
  origin: RoomPosition,
  path: readonly RoomPosition[],
): readonly DirectionConstant[] {
  const directions: DirectionConstant[] = [];
  let previous = origin;
  for (const step of path) {
    if (step.roomName !== previous.roomName) throw new Error("cross-room-path-result");
    const direction = directionFor(step.x - previous.x, step.y - previous.y);
    if (direction === null) throw new Error("invalid-path-step");
    directions.push(direction);
    previous = step;
  }
  return directions;
}

function directionFor(deltaX: number, deltaY: number): DirectionConstant | null {
  const key = `${String(deltaX)},${String(deltaY)}`;
  const directions: Readonly<Record<string, DirectionConstant>> = {
    "-1,-1": 8,
    "-1,0": 7,
    "-1,1": 6,
    "0,-1": 1,
    "0,1": 5,
    "1,-1": 2,
    "1,0": 3,
    "1,1": 4,
  };
  return directions[key] ?? null;
}
