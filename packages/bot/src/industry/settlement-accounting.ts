export const INDUSTRY_SETTLEMENT_ACCOUNTING_FIELDS = Object.freeze([
  "energyInput",
  "resourceInput",
  "resourceOutput",
] as const);

export interface IndustrySettlementAccounting {
  readonly energyInput: number;
  readonly resourceInput: number;
  readonly resourceOutput: number;
}

export type IndustrySettlementAccountingRow = readonly [
  energyInput: number,
  resourceInput: number,
  resourceOutput: number,
];

export const EMPTY_INDUSTRY_SETTLEMENT_ACCOUNTING: IndustrySettlementAccounting = Object.freeze({
  energyInput: 0,
  resourceInput: 0,
  resourceOutput: 0,
});

export function industrySettlementAccounting(
  energyInput: number,
  resourceInput: number,
  resourceOutput: number,
): IndustrySettlementAccounting {
  return Object.freeze({ energyInput, resourceInput, resourceOutput });
}

export function industrySettlementAccountingRow(
  value: IndustrySettlementAccounting,
): IndustrySettlementAccountingRow {
  return Object.freeze([value.energyInput, value.resourceInput, value.resourceOutput]);
}

export function hasIndustrySettlementAccounting(value: IndustrySettlementAccounting): boolean {
  return value.energyInput > 0 || value.resourceInput > 0 || value.resourceOutput > 0;
}

export function sumIndustrySettlementAccounting(
  values: readonly IndustrySettlementAccounting[],
): IndustrySettlementAccounting {
  let energyInput = 0;
  let resourceInput = 0;
  let resourceOutput = 0;
  for (const value of values) {
    energyInput = saturatingAdd(energyInput, value.energyInput);
    resourceInput = saturatingAdd(resourceInput, value.resourceInput);
    resourceOutput = saturatingAdd(resourceOutput, value.resourceOutput);
  }
  return industrySettlementAccounting(energyInput, resourceInput, resourceOutput);
}

function saturatingAdd(left: number, right: number): number {
  return left > Number.MAX_SAFE_INTEGER - right ? Number.MAX_SAFE_INTEGER : left + right;
}
