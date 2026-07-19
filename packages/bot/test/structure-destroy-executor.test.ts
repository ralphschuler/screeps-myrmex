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
const linkIntent: DestroyOwnedStructureIntent = {
  colonyId: "W1N1",
  kind: "destroy-owned-structure",
  layoutFingerprint: "layout-a",
  observationFingerprint: "observation-a",
  policyFingerprint: "policy-a",
  replacementExpectedEnergy: 0,
  replacementId: "link-reserve-exact",
  replacementRequiresZeroCooldown: true,
  replacementStructureType: "link",
  roomName: "W1N1",
  stableId: "remove-reserve-link/link-reserve-external",
  targetId: "link-reserve-external",
  targetRequiresEmptyStore: true,
  targetRequiresZeroCooldown: true,
  targetStructureType: "link",
  x: 10,
  y: 11,
};
const labIntent: DestroyOwnedStructureIntent = {
  colonyId: "W1N1",
  kind: "destroy-owned-structure",
  layoutFingerprint: "layout-a",
  observationFingerprint: "observation-a",
  policyFingerprint: "policy-a",
  replacementId: "lab-replacement",
  replacementStructureType: "lab",
  roomName: "W1N1",
  stableId: "remove-lab/lab-obsolete",
  targetId: "lab-obsolete",
  targetRequiresEmptyStore: true,
  targetRequiresZeroCooldown: true,
  targetStructureType: "lab",
  x: 10,
  y: 11,
};
const towerIntent: DestroyOwnedStructureIntent = {
  colonyId: "W1N1",
  kind: "destroy-owned-structure",
  layoutFingerprint: "layout-a",
  observationFingerprint: "observation-a",
  policyFingerprint: "policy-a",
  replacementId: "tower-replacement",
  replacementStructureType: "tower",
  roomName: "W1N1",
  stableId: "remove-tower/tower-obsolete",
  targetId: "tower-obsolete",
  targetRequiresEmptyStore: true,
  targetStructureType: "tower",
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

  it("revalidates an empty active tower and one immediately operational replacement", () => {
    const room = { controller: { my: true }, name: "W1N1" } as unknown as Room;
    const destroy = vi.fn(() => 0);
    const tower = (
      id: string,
      energy: number,
      options: { readonly active?: boolean; readonly my?: boolean } = {},
    ) =>
      ({
        destroy: id === towerIntent.targetId ? destroy : vi.fn(() => 0),
        id,
        isActive: () => options.active ?? true,
        my: options.my ?? true,
        pos: { roomName: "W1N1", x: id === towerIntent.targetId ? 10 : 12, y: 11 },
        room,
        store: {
          getUsedCapacity: (resource?: string) =>
            resource === undefined || resource === "energy" ? energy : 0,
        },
        structureType: "tower",
      }) as unknown as Structure;
    const adapter = (target = tower("tower-obsolete", 0), replacementEnergy = 10) => ({
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => room,
      resolveStructure: (id: string) =>
        id === towerIntent.targetId
          ? target
          : id === towerIntent.replacementId
            ? tower("tower-replacement", replacementEnergy)
            : null,
    });

    expect(new StructureDestroyExecutor().execute([towerIntent], adapter())[0]).toMatchObject({
      called: true,
      code: "OK",
    });
    expect(destroy).toHaveBeenCalledOnce();
    expect(
      new StructureDestroyExecutor().execute([towerIntent], adapter(undefined, 9))[0],
    ).toMatchObject({ called: false, fault: "replacement-underfunded" });
    expect(
      new StructureDestroyExecutor().execute([towerIntent], adapter(tower("tower-obsolete", 1)))[0],
    ).toMatchObject({ called: false, fault: "target-not-empty" });
  });

  it("revalidates one empty zero-cooldown lab and an exact active replacement", () => {
    const room = { controller: { my: true }, name: "W1N1" } as unknown as Room;
    const destroy = vi.fn(() => 0);
    const lab = (
      id: string,
      options: {
        readonly active?: boolean;
        readonly cooldown?: number;
        readonly energy?: number;
        readonly energyCapacity?: number;
        readonly mineral?: number;
        readonly mineralCapacity?: number;
        readonly mineralType?: string | null;
      } = {},
    ) => {
      const energy = options.energy ?? 0;
      const mineral = options.mineral ?? 0;
      const energyCapacity = options.energyCapacity ?? 2_000;
      const mineralCapacity = options.mineralCapacity ?? 3_000;
      return {
        cooldown: options.cooldown ?? 0,
        destroy: id === labIntent.targetId ? destroy : vi.fn(() => 0),
        id,
        isActive: () => options.active ?? true,
        mineralType: options.mineralType ?? null,
        my: true,
        pos: { roomName: "W1N1", x: id === labIntent.targetId ? 10 : 12, y: 11 },
        room,
        store: {
          getCapacity: (resource?: string) =>
            resource === "energy"
              ? energyCapacity
              : resource === undefined
                ? null
                : mineralCapacity,
          getFreeCapacity: (resource?: string) =>
            resource === "energy"
              ? energyCapacity - energy
              : resource === undefined
                ? null
                : mineralCapacity - mineral,
          getUsedCapacity: (resource?: string) =>
            resource === "energy" ? energy : resource === undefined ? energy + mineral : mineral,
        },
        structureType: "lab",
      } as unknown as Structure;
    };
    const adapter = (target = lab("lab-obsolete"), replacement = lab("lab-replacement")) => ({
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => room,
      resolveStructure: (id: string) =>
        id === labIntent.targetId ? target : id === labIntent.replacementId ? replacement : null,
    });

    expect(new StructureDestroyExecutor().execute([labIntent], adapter())[0]).toMatchObject({
      called: true,
      code: "OK",
    });
    expect(destroy).toHaveBeenCalledOnce();
    for (const [value, fault] of [
      [adapter(lab("lab-obsolete", { cooldown: 1 })), "target-cooldown"],
      [adapter(lab("lab-obsolete", { energy: 1 })), "target-not-empty"],
      [adapter(lab("lab-obsolete", { mineral: 1, mineralType: "H" })), "target-not-empty"],
      [adapter(lab("lab-obsolete", { energyCapacity: 1_999 })), "target-not-empty"],
      [adapter(undefined, lab("lab-replacement", { active: false })), "replacement-mismatch"],
    ] as const)
      expect(new StructureDestroyExecutor().execute([labIntent], value)[0]).toMatchObject({
        called: false,
        fault,
      });
  });

  it("revalidates empty targets and exact active 800-capacity idle replacement energy", () => {
    const room = { controller: { my: true }, name: "W1N1" } as unknown as Room;
    const destroy = vi.fn(() => 0);
    const link = (
      id: string,
      options: {
        readonly active?: boolean;
        readonly capacity?: number;
        readonly cooldown?: number;
        readonly my?: boolean;
        readonly used?: number;
      } = {},
    ) => {
      const capacity = options.capacity ?? 800;
      const used = options.used ?? 0;
      return {
        cooldown: options.cooldown ?? 0,
        destroy: id === linkIntent.targetId ? destroy : vi.fn(() => 0),
        id,
        isActive: () => options.active ?? true,
        my: options.my ?? true,
        pos: { roomName: "W1N1", x: id === linkIntent.targetId ? 10 : 12, y: 11 },
        room,
        store: {
          getCapacity: () => capacity,
          getFreeCapacity: () => capacity - used,
          getUsedCapacity: () => used,
        },
        structureType: "link",
      } as unknown as Structure;
    };
    const adapter = (
      target = link("link-reserve-external"),
      replacement = link("link-reserve-exact"),
    ) => ({
      hasCurrentHostiles: () => false,
      isCurrentCommitment: () => true,
      resolveRoom: () => room,
      resolveStructure: (id: string) =>
        id === linkIntent.targetId ? target : id === linkIntent.replacementId ? replacement : null,
    });

    expect(new StructureDestroyExecutor().execute([linkIntent], adapter())[0]).toMatchObject({
      called: true,
      code: "OK",
    });
    expect(destroy).toHaveBeenCalledOnce();
    const stockedIntent = { ...linkIntent, replacementExpectedEnergy: 300 } as const;
    expect(
      new StructureDestroyExecutor().execute(
        [stockedIntent],
        adapter(undefined, link("link-reserve-exact", { used: 300 })),
      )[0],
    ).toMatchObject({ called: true, code: "OK" });
    expect(
      new StructureDestroyExecutor().execute(
        [stockedIntent],
        adapter(undefined, link("link-reserve-exact", { used: 299 })),
      )[0],
    ).toMatchObject({ called: false, fault: "replacement-energy-mismatch" });
    for (const [value, fault] of [
      [adapter(link("link-reserve-external", { active: false })), "target-not-empty"],
      [adapter(link("link-reserve-external", { my: false })), "target-not-empty"],
      [adapter(link("link-reserve-external", { used: 1 })), "target-not-empty"],
      [adapter(link("link-reserve-external", { capacity: 799 })), "target-not-empty"],
      [adapter(link("link-reserve-external", { cooldown: 1 })), "target-cooldown"],
      [adapter(undefined, link("link-reserve-exact", { active: false })), "replacement-mismatch"],
      [adapter(undefined, link("link-reserve-exact", { used: 1 })), "replacement-energy-mismatch"],
      [
        adapter(undefined, link("link-reserve-exact", { capacity: 799 })),
        "replacement-energy-mismatch",
      ],
      [adapter(undefined, link("link-reserve-exact", { cooldown: 1 })), "replacement-cooldown"],
    ] as const)
      expect(new StructureDestroyExecutor().execute([linkIntent], value)[0]).toMatchObject({
        called: false,
        fault,
      });
    expect(destroy).toHaveBeenCalledTimes(2);
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
