export type ObservedStructureOwnership = "owned" | "foreign" | "unowned";

/** Shared movement/layout whitelist; ramparts follow the engine ownership/public rule. */
export function isObservedStructureStaticallyWalkable(
  structureType: string,
  ownership: ObservedStructureOwnership,
  isPublic: boolean | null | undefined,
): boolean {
  return (
    structureType === "container" ||
    structureType === "road" ||
    (structureType === "rampart" && (ownership === "owned" || isPublic === true))
  );
}
