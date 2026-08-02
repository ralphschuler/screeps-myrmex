declare const URL: {
  new (input: string, base?: string): unknown;
};

interface ImportMeta {
  readonly url: string;
}

declare module "node:crypto" {
  interface Hash {
    digest(encoding: "hex"): string;
    update(data: Uint8Array): Hash;
  }

  export function createHash(algorithm: "sha256"): Hash;
}

declare module "node:fs/promises" {
  export function readFile(path: unknown): Promise<Uint8Array>;
  export function readFile(path: unknown, encoding: "utf8"): Promise<string>;
}
