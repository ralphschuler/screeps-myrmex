import {
  PERSISTENT_STATE_OWNERS,
  type JsonObject,
  type MyrmexMemory,
  type OwnerStateView,
  type PersistentOwnerState,
  type PersistentStateOwner,
  type StateView,
} from "./schema";
import {
  cloneCurrentMemory,
  cloneJsonObject,
  isCurrentMyrmexMemory,
  isJsonObject,
  readonlyOwnerView,
  readonlyStateView,
  validateJsonValue,
} from "./validation";

export type MemoryCommitFaultCode =
  "invalid-owner-state" | "invalid-root" | "open-transaction" | "stale-root";

export interface MemoryCommitFault {
  readonly code: MemoryCommitFaultCode;
  readonly message: string;
  readonly owner?: PersistentStateOwner;
  readonly path?: string;
}

export interface MemoryStageResult {
  readonly fault?: MemoryCommitFault;
  readonly staged: boolean;
}

export type MemoryCommitResult =
  | {
      readonly committed: true;
      readonly owners: readonly PersistentStateOwner[];
      readonly revision: number;
    }
  | {
      readonly committed: false;
      readonly faults: readonly MemoryCommitFault[];
    };

/**
 * Mutable state for one authority. Calling `stage` does not touch Screeps Memory; only the
 * manager's reconciliation commit can publish it.
 */
export class OwnerMemoryTransaction {
  readonly #manager: MemoryManager;
  readonly #owner: PersistentStateOwner;
  readonly #token: symbol;
  #closed = false;
  #draft: unknown;

  constructor(
    manager: MemoryManager,
    owner: PersistentStateOwner,
    token: symbol,
    initial: JsonObject,
  ) {
    this.#manager = manager;
    this.#owner = owner;
    this.#token = token;
    this.#draft = cloneJsonObject(initial);
  }

  get owner(): PersistentStateOwner {
    return this.#owner;
  }

  view(): OwnerStateView {
    this.assertOpen();
    if (!isJsonObject(this.#draft)) {
      throw new Error(`Transaction ${this.#owner} does not currently contain a JSON object`);
    }
    return readonlyOwnerView(this.#draft);
  }

  /** Replaces the owner draft. Runtime validation is deliberately deferred to `stage`. */
  replace(value: unknown): this {
    this.assertOpen();
    this.#draft = isJsonObject(value) ? cloneJsonObject(value) : value;
    return this;
  }

  /** Applies a mutation to an isolated clone; a throwing mutator leaves the prior draft intact. */
  mutate(mutator: (draft: JsonObject) => void): this {
    this.assertOpen();
    if (!isJsonObject(this.#draft)) {
      throw new Error(`Transaction ${this.#owner} cannot mutate invalid owner state`);
    }

    const candidate = cloneJsonObject(this.#draft);
    mutator(candidate);
    this.#draft = candidate;
    return this;
  }

  stage(): MemoryStageResult {
    this.assertOpen();
    this.#closed = true;
    return this.#manager.stageTransaction(this.#owner, this.#token, this.#draft);
  }

  discard(): void {
    this.assertOpen();
    this.#closed = true;
    this.#manager.discardTransaction(this.#owner, this.#token);
  }

  private assertOpen(): void {
    if (this.#closed) {
      throw new Error(`Transaction ${this.#owner} is already closed`);
    }
  }
}

/** The sole owner of a validated `Memory.myrmex` root for one tick. */
export class MemoryManager {
  readonly #memory: Memory;
  readonly #gameTime: number;
  readonly #baseRoot: MyrmexMemory;
  readonly #active = new Map<PersistentStateOwner, symbol>();
  readonly #staged = new Map<PersistentStateOwner, JsonObject>();
  readonly #stagingFaults = new Map<PersistentStateOwner, MemoryCommitFault>();
  #root: MyrmexMemory;
  #reconciled = false;

  constructor(memory: Memory, root: MyrmexMemory, gameTime: number) {
    if (!isCurrentMyrmexMemory(root) || memory.myrmex !== root) {
      throw new Error("MemoryManager requires the current validated Memory.myrmex root");
    }

    this.#memory = memory;
    this.#root = root;
    this.#baseRoot = root;
    this.#gameTime = normalizeTick(gameTime);
  }

  view(): StateView {
    return readonlyStateView(this.#root);
  }

  ownerView(owner: PersistentStateOwner): OwnerStateView {
    return readonlyOwnerView(this.#root[owner]);
  }

  transaction(owner: PersistentStateOwner): OwnerMemoryTransaction {
    this.assertBeforeReconciliation();
    if (this.#active.has(owner) || this.#staged.has(owner) || this.#stagingFaults.has(owner)) {
      throw new Error(`Owner ${owner} already has a transaction this tick`);
    }

    const token = Symbol(owner);
    this.#active.set(owner, token);
    return new OwnerMemoryTransaction(this, owner, token, this.#root[owner]);
  }

  /** Discards an owner's active or staged writes, for example after a system fault. */
  discard(owner: PersistentStateOwner): void {
    this.assertBeforeReconciliation();
    this.#active.delete(owner);
    this.#staged.delete(owner);
    this.#stagingFaults.delete(owner);
  }

  discardAll(): void {
    this.assertBeforeReconciliation();
    this.clearTransactions();
  }

  /**
   * Performs the only normal persistent write. All owner drafts and the complete candidate root are
   * validated before the single `Memory.myrmex` assignment.
   */
  commitReconciliation(): MemoryCommitResult {
    this.assertBeforeReconciliation();
    this.#reconciled = true;

    const faults: MemoryCommitFault[] = [...this.#stagingFaults.values()];
    for (const owner of this.#active.keys()) {
      faults.push({
        code: "open-transaction",
        owner,
        message: `Owner ${owner} did not stage or discard its transaction before reconciliation`,
      });
    }

    if (this.#memory.myrmex !== this.#baseRoot || !isCurrentMyrmexMemory(this.#memory.myrmex)) {
      faults.push({
        code: "stale-root",
        message: "Memory.myrmex changed after the manager opened",
      });
    }

    if (faults.length > 0) {
      this.clearTransactions();
      return { committed: false, faults: sortFaults(faults) };
    }

    const base = cloneCurrentMemory(this.#root);
    const owners = PERSISTENT_STATE_OWNERS.filter((owner) => this.#staged.has(owner));
    const ownerState = Object.fromEntries(
      PERSISTENT_STATE_OWNERS.map((owner) => {
        const staged = this.#staged.get(owner);
        return [owner, cloneJsonObject(staged ?? base[owner])];
      }),
    ) as PersistentOwnerState;
    const candidate: MyrmexMemory = {
      ...ownerState,
      meta: {
        ...base.meta,
        revision: base.meta.revision + 1,
        lastTick: Math.max(base.meta.lastTick, this.#gameTime),
      },
    };

    if (!isCurrentMyrmexMemory(candidate)) {
      this.clearTransactions();
      return {
        committed: false,
        faults: [
          {
            code: "invalid-root",
            message: "Validated owner transactions produced an invalid MYRMEX root",
          },
        ],
      };
    }

    this.#memory.myrmex = candidate;
    this.#root = candidate;
    this.clearTransactions();
    return { committed: true, owners, revision: candidate.meta.revision };
  }

  /** @internal Called only by OwnerMemoryTransaction. */
  stageTransaction(owner: PersistentStateOwner, token: symbol, value: unknown): MemoryStageResult {
    this.assertBeforeReconciliation();
    this.assertTransaction(owner, token);
    this.#active.delete(owner);

    const json = validateJsonValue(value);
    if (!json.valid || !isJsonObject(value)) {
      const fault: MemoryCommitFault = {
        code: "invalid-owner-state",
        owner,
        path: json.valid ? "$" : json.path,
        message: json.valid ? "owner state must be a JSON object" : json.message,
      };
      this.#stagingFaults.set(owner, fault);
      return { staged: false, fault };
    }

    this.#staged.set(owner, cloneJsonObject(value));
    return { staged: true };
  }

  /** @internal Called only by OwnerMemoryTransaction. */
  discardTransaction(owner: PersistentStateOwner, token: symbol): void {
    this.assertBeforeReconciliation();
    this.assertTransaction(owner, token);
    this.#active.delete(owner);
  }

  private assertTransaction(owner: PersistentStateOwner, token: symbol): void {
    if (this.#active.get(owner) !== token) {
      throw new Error(`Transaction token for ${owner} is no longer active`);
    }
  }

  private assertBeforeReconciliation(): void {
    if (this.#reconciled) {
      throw new Error("MemoryManager reconciliation has already completed for this tick");
    }
  }

  private clearTransactions(): void {
    this.#active.clear();
    this.#staged.clear();
    this.#stagingFaults.clear();
  }
}

function sortFaults(faults: readonly MemoryCommitFault[]): readonly MemoryCommitFault[] {
  const ownerIndex = (owner: PersistentStateOwner | undefined): number =>
    owner === undefined ? -1 : PERSISTENT_STATE_OWNERS.indexOf(owner);

  return [...faults].sort(
    (left, right) =>
      ownerIndex(left.owner) - ownerIndex(right.owner) || left.code.localeCompare(right.code),
  );
}

function normalizeTick(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
