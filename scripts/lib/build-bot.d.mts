export interface BotBundleEvidence {
  readonly buildSha: string;
  readonly bytes: number;
  readonly inputCount: number;
  readonly sha256: string;
}

export interface BotBundleResult {
  readonly contents: Uint8Array;
  readonly evidence: BotBundleEvidence;
  readonly metafile: {
    readonly inputs: Readonly<Record<string, unknown>>;
  };
}

export function buildBotBundle(input: {
  readonly buildSha: string;
  readonly logLevel?: string;
}): Promise<BotBundleResult>;
