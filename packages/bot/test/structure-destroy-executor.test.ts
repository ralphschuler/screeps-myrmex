import { describe, expect, it, vi } from "vitest";
import {
  StructureDestroyExecutor,
  type DestroyOwnedStructureIntent,
  type StructureDestroyExecutionAdapter,
} from "../src/layout";

const extensionIntent: DestroyOwnedStructureIntent = {
  colonyId: "W1N1",
  kind: "destroy-owned-structure",
  layoutFingerprint: "layout-a",
  observationFingerprint: "observation-a",
  policyFingerprint: "policy-a",
  replacementId: "extension-replacement",
  replacementStructureType: "extension",
  roomName: "W1N1",
  stableId: "remove-extension/extension-obsolete",
  targetId: "extension-obsolete",
  targetRequiresEmptyStore: true,
  targetStructureType: "extension",
  x: 10,
  y: 11,
};
const intent = extensionIntent;
const containerIntent: DestroyOwnedStructureIntent = {
  colonyId: "W1N1",
  kind: "destroy-owned-structure",
  layoutFingerprint: "layout-a",
  observationFingerprint: "observation-a",
  policyFingerprint: "policy-a",
  replacementId: "container-service",
  replacementStructureType: "container",
  roomName: "W1N1",
  stableId: "remove-container/container-redundant",
  targetId: "container-redundant",
  targetRequiresEmptyStore: true,
  targetStructureType: "container",
  x: 10,
  y: 11,
};

function fixture(code = 0) {
  const destroy = vi.fn(() => code);
  const room = { controller: { my: true }, name: "W1N1" } as unknown as Room;
  const target = {
    destroy,
    id: intent.targetId,
    isActive: () => true,
    my: true,
    pos: { roomName: "W1N1", x: 10, y: 11 },
    room,
    store: { getUsedCapacity: () => 0 },
    structureType: "extension",
  } as unknown as Structure;
  const replacement = {
    id: intent.replacementId,
    isActive: () => true,
    my: true,
    pos: { roomName: "W1N1", x: 12, y: 11 },
    room,
    structureType: "extension",
  } as unknown as Structure;
  return {
    adapter: {
      hasCurrentHostiles: () => false,
      isCurrentCommitment: (_roomName: string, fingerprint: string) => fingerprint === "layout-a",
      resolveRoom: () => room,
      resolveStructure: (id: string) => (id === intent.targetId ? target : replacement),
    },
    destroy,
    target,
  };
}
function changedTarget(
  value: ReturnType<typeof fixture>,
  change: {
    readonly destroy?: () => number | undefined;
    readonly pos?: { readonly roomName: string; readonly x: number; readonly y: number };
    readonly structureType?: string;
  },
): Structure {
  const original = value.target as Structure & {
    readonly my?: boolean;
    readonly store?: { getUsedCapacity(): number | null };
  };
  return {
    destroy: change.destroy ?? value.destroy,
    id: original.id,
    isActive: () => original.isActive(),
    my: original.my,
    pos: change.pos ?? original.pos,
    room: original.room,
    store: original.store,
    structureType: change.structureType ?? original.structureType,
  } as unknown as Structure;
}

describe("StructureDestroyExecutor", () => {
  it.each([
    [0, "OK"],
    [-1, "ERR_NOT_OWNER"],
    [-4, "ERR_BUSY"],
    [-99, "UNEXPECTED"],
  ] as const)("normalizes documented destroy result %s as %s after one call", (code, expected) => {
    const value = fixture(code);
    const result = new StructureDestroyExecutor().execute([intent], value.adapter);

    expect(value.destroy).toHaveBeenCalledOnce();
    expect(result[0]).toMatchObject({ called: true, code: expected, intent });
  });

  it("revalidates current safety and exact target identity before any irreversible call", () => {
    const executor = new StructureDestroyExecutor();
    const cases: StructureDestroyExecutionAdapter[] = [
      { ...fixture().adapter, isCurrentCommitment: () => false },
      { ...fixture().adapter, resolveRoom: () => null },
      {
        ...fixture().adapter,
        resolveRoom: () => ({ controller: { my: false }, name: "W1N1" }) as unknown as Room,
      },
      { ...fixture().adapter, hasCurrentHostiles: () => true },
      { ...fixture().adapter, resolveStructure: () => null },
      {
        ...fixture().adapter,
        resolveStructure: () =>
          changedTarget(fixture(), { pos: { roomName: "W1N1", x: 12, y: 11 } }),
      },
      {
        ...fixture().adapter,
        resolveStructure: () => changedTarget(fixture(), { structureType: "spawn" }),
      },
    ];
    for (const adapter of cases) {
      const result = executor.execute([intent], adapter);
      expect(result[0]?.called).toBe(false);
    }
  });

  it("revalidates an empty owned extension and its completed owned replacement", () => {
    const room = { controller: { my: true }, name: "W1N1" } as unknown as Room;
    const destroy = vi.fn(() => 0);
    const extension = (
      id: string,
      options: {
        readonly active?: boolean;
        readonly my?: boolean;
        readonly roomName?: string;
        readonly used?: number;
      } = {},
    ) =>
      ({
        destroy: id === extensionIntent.targetId ? destroy : vi.fn(() => 0),
        id,
        isActive: () => options.active ?? true,
        my: options.my ?? true,
        pos: {
          roomName: options.roomName ?? "W1N1",
          x: id === extensionIntent.targetId ? 10 : 12,
          y: 11,
        },
        room: { name: options.roomName ?? "W1N1" },
        store: { getUsedCapacity: () => options.used ?? 0 },
        structureType: "extension",
      }) as unknown as Structure;
    const adapter = (
      target = extension("extension-obsolete"),
      replacement: Structure | null = extension("extension-replacement"),
    ) => ({
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => room,
      resolveStructure: (id: string) =>
        id === extensionIntent.targetId
          ? target
          : id === extensionIntent.replacementId
            ? replacement
            : null,
    });

    expect(new StructureDestroyExecutor().execute([extensionIntent], adapter())[0]).toMatchObject({
      called: true,
      code: "OK",
    });
    expect(destroy).toHaveBeenCalledOnce();
    destroy.mockReturnValue(-4);
    expect(new StructureDestroyExecutor().execute([extensionIntent], adapter())[0]).toMatchObject({
      called: true,
      code: "ERR_BUSY",
      fault: null,
    });
    for (const [value, fault] of [
      [adapter(extension("extension-obsolete", { used: 1 })), "target-not-empty"],
      [adapter(extension("extension-obsolete", { my: false })), "target-not-empty"],
      [adapter(undefined, null), "replacement-absent"],
      [
        adapter(undefined, extension("extension-replacement", { active: false })),
        "replacement-mismatch",
      ],
      [
        adapter(undefined, extension("extension-replacement", { roomName: "W2N2" })),
        "replacement-mismatch",
      ],
    ] as const)
      expect(new StructureDestroyExecutor().execute([extensionIntent], value)[0]).toMatchObject({
        called: false,
        fault,
      });
  });

  it("revalidates an empty room container and its exact current service replacement", () => {
    const room = { controller: { my: true }, name: "W1N1" } as unknown as Room;
    const destroy = vi.fn(() => 0);
    const container = (
      id: string,
      options: {
        readonly active?: boolean;
        readonly roomName?: string;
        readonly structureType?: string;
        readonly used?: number;
      } = {},
    ) =>
      ({
        destroy: id === containerIntent.targetId ? destroy : vi.fn(() => 0),
        id,
        isActive: () => options.active ?? true,
        pos: {
          roomName: options.roomName ?? "W1N1",
          x: id === containerIntent.targetId ? 10 : 12,
          y: 11,
        },
        room: { name: options.roomName ?? "W1N1" },
        store: { getUsedCapacity: () => options.used ?? 0 },
        structureType: options.structureType ?? "container",
      }) as unknown as Structure;
    const adapter = (
      target = container("container-redundant"),
      replacement: Structure | null = container("container-service"),
    ) => ({
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => room,
      resolveStructure: (id: string) =>
        id === containerIntent.targetId
          ? target
          : id === containerIntent.replacementId
            ? replacement
            : null,
    });

    expect(new StructureDestroyExecutor().execute([containerIntent], adapter())[0]).toMatchObject({
      called: true,
      code: "OK",
    });
    expect(destroy).toHaveBeenCalledOnce();
    for (const [value, fault] of [
      [adapter(container("container-redundant", { used: 1 })), "target-not-empty"],
      [adapter(undefined, null), "replacement-absent"],
      [
        adapter(undefined, container("container-service", { active: false })),
        "replacement-mismatch",
      ],
      [
        adapter(undefined, container("container-service", { structureType: "extension" })),
        "replacement-mismatch",
      ],
      [
        adapter(undefined, container("container-service", { roomName: "W2N2" })),
        "replacement-mismatch",
      ],
    ] as const)
      expect(new StructureDestroyExecutor().execute([containerIntent], value)[0]).toMatchObject({
        called: false,
        fault,
      });
  });

  it("isolates adapter and command faults", () => {
    const value = fixture();
    expect(
      new StructureDestroyExecutor().execute([intent], {
        ...value.adapter,
        resolveStructure: () => {
          throw new Error("fault");
        },
      })[0],
    ).toMatchObject({ called: false, code: "UNEXPECTED", fault: "adapter-fault" });
    const commandFaultTarget = changedTarget(value, { destroy: () => void 0 });
    expect(
      new StructureDestroyExecutor().execute([intent], {
        ...value.adapter,
        resolveStructure: (id) =>
          id === intent.targetId ? commandFaultTarget : value.adapter.resolveStructure(id),
      })[0],
    ).toMatchObject({ called: true, code: "UNEXPECTED", fault: "adapter-fault" });
  });
});
