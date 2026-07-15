import type { MyrmexMemory } from "../state/schema";

export interface RuntimeGame {
  readonly cpu: {
    readonly bucket: number;
    getUsed(): number;
  };
  readonly rooms: Readonly<Record<string, Room>>;
  readonly shard: {
    readonly name: string;
  };
  readonly time: number;
}

export interface TickContext {
  readonly game: RuntimeGame;
  readonly memory: Memory;
  readonly state: MyrmexMemory;
}
