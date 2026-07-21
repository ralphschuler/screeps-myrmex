export interface StockBand {
  readonly resourceType: string;
  readonly min: number;
  readonly target: number;
  readonly max: number;
}
export interface ResourceStock {
  readonly resourceType: string;
  readonly amount: number;
}
export interface IndustryStoreState {
  readonly active: boolean;
  readonly freeCapacity: number;
  readonly stocks: readonly ResourceStock[];
}
export interface TerminalState extends IndustryStoreState {
  readonly cooldown: number;
}
export interface DownstreamCommitment {
  readonly amount: number;
  readonly fundedAmount: number;
  readonly id: string;
  readonly resourceType: string;
}
export interface IndustryRoomState {
  readonly bands: readonly StockBand[];
  readonly commitments: readonly DownstreamCommitment[];
  readonly controllerLevel: number;
  readonly extractor: { readonly active: boolean; readonly cooldown: number } | null;
  readonly mineral: {
    readonly amount: number;
    readonly id: string;
    readonly pos?: { readonly roomName: string; readonly x: number; readonly y: number };
    readonly resourceType: string;
    readonly ticksToRegeneration: number | null;
  } | null;
  readonly protectedEnergy: number;
  readonly roomName: string;
  readonly storage: IndustryStoreState | null;
  readonly terminal: TerminalState | null;
}
export interface InternalSendRequest {
  readonly amount: number;
  readonly deadline: number;
  readonly destinationRoom: string;
  readonly id: string;
  readonly resourceType: string;
  readonly sourceRoom: string;
}
export interface IndustryPlannerLimits {
  readonly maxExtractionProposals: number;
  readonly maxRoomsScanned: number;
  readonly maxSendProposals: number;
  readonly maxSendRequestsScanned: number;
}
export interface ExtractionProposal {
  readonly amount: number;
  readonly identity: string;
  readonly mineralId: string;
  readonly resourceType: string;
  readonly roomName: string;
}
export interface TerminalSendProposal {
  readonly amount: number;
  readonly deadline: number;
  readonly destinationRoom: string;
  readonly identity: string;
  readonly requestId: string;
  readonly resourceType: string;
  readonly sourceRoom: string;
  readonly transactionEnergy: number;
}
export type IndustryDeferralReason =
  | "cooldown"
  | "destination-capacity"
  | "duplicate-request"
  | "expired"
  | "inactive"
  | "insufficient-energy"
  | "insufficient-resource"
  | "missing-destination"
  | "missing-extractor"
  | "missing-mineral"
  | "missing-source"
  | "no-funded-deficit"
  | "proposal-limit"
  | "rcl"
  | "regenerating"
  | "scan-limit"
  | "stock-limit"
  | "terminal-reserved";
export interface IndustryPlan {
  readonly accounting: {
    readonly consumed: number;
    readonly hauled: number;
    readonly mined: number;
    readonly reserved: number;
    readonly sent: number;
    readonly transactionEnergy: number;
    readonly unmet: number;
  };
  readonly deferrals: readonly {
    readonly count: number;
    readonly reason: IndustryDeferralReason;
  }[];
  readonly extraction: readonly ExtractionProposal[];
  readonly scannedRooms: number;
  readonly scannedSendRequests: number;
  readonly sends: readonly TerminalSendProposal[];
}
export interface IndustryPlannerInput {
  readonly limits: IndustryPlannerLimits;
  readonly requests: readonly InternalSendRequest[];
  readonly rooms: readonly IndustryRoomState[];
  /** Layout-owned terminal destinations that cannot participate in an internal send. */
  readonly terminalSendBlockedRoomNames?: ReadonlySet<string>;
  readonly tick: number;
  readonly transactionCost: (amount: number, sourceRoom: string, destinationRoom: string) => number;
}
interface MutableRoom {
  readonly bands: ReadonlyMap<string, StockBand>;
  readonly room: IndustryRoomState;
  readonly terminalStocks: Map<string, number>;
  readonly totalStocks: Map<string, number>;
  terminalFree: number;
  terminalUsed: boolean;
}
const ENERGY = "energy";

export class IndustryDirector {
  public plan(input: IndustryPlannerInput): IndustryPlan {
    return planIndustry(input);
  }
}

export function planIndustry(input: IndustryPlannerInput): IndustryPlan {
  const deferred = new Map<IndustryDeferralReason, number>();
  const orderedRooms = [...input.rooms].sort((a, b) => compare(a.roomName, b.roomName));
  const rooms = orderedRooms.slice(0, integer(input.limits.maxRoomsScanned));
  increment(deferred, "scan-limit", orderedRooms.length - rooms.length);
  const extraction = planExtraction(rooms, integer(input.limits.maxExtractionProposals), deferred);
  const roomMap = new Map(rooms.map((room) => [room.roomName, mutableRoom(room)] as const));
  const orderedRequests = [...input.requests].sort(
    (a, b) => a.deadline - b.deadline || compare(a.id, b.id) || compare(a.sourceRoom, b.sourceRoom),
  );
  const requests = orderedRequests.slice(0, integer(input.limits.maxSendRequestsScanned));
  increment(deferred, "scan-limit", orderedRequests.length - requests.length);
  const sends = planSends(
    requests,
    roomMap,
    input.terminalSendBlockedRoomNames ?? new Set(),
    input.tick,
    integer(input.limits.maxSendProposals),
    input.transactionCost,
    deferred,
  );
  const consumed = rooms.reduce(
    (total, room) => total + room.commitments.reduce((sum, item) => sum + positive(item.amount), 0),
    0,
  );
  const reserved = rooms.reduce(
    (total, room) =>
      total + room.commitments.reduce((sum, item) => sum + positive(item.fundedAmount), 0),
    0,
  );
  const mined = extraction.reduce((total, item) => total + item.amount, 0);
  const sent = sends.reduce((total, item) => total + item.amount, 0);
  const transactionEnergy = sends.reduce((total, item) => total + item.transactionEnergy, 0);
  return {
    accounting: {
      consumed,
      hauled: 0,
      mined,
      reserved,
      sent,
      transactionEnergy,
      unmet: Math.max(0, consumed - mined - sent),
    },
    deferrals: [...deferred]
      .filter(([, count]) => count > 0)
      .sort(([a], [b]) => compare(a, b))
      .map(([reason, count]) => ({ count, reason })),
    extraction,
    scannedRooms: rooms.length,
    scannedSendRequests: requests.length,
    sends,
  };
}

function planExtraction(
  rooms: readonly IndustryRoomState[],
  limit: number,
  deferred: Map<IndustryDeferralReason, number>,
): ExtractionProposal[] {
  const proposals: ExtractionProposal[] = [];
  for (const room of rooms) {
    const mineral = room.mineral;
    const extractor = room.extractor;
    if (mineral === null) increment(deferred, "missing-mineral");
    else if (extractor === null) increment(deferred, "missing-extractor");
    else if (room.controllerLevel < 6) increment(deferred, "rcl");
    else if (!extractor.active) increment(deferred, "inactive");
    else if (extractor.cooldown > 0) increment(deferred, "cooldown");
    else if (mineral.amount <= 0) increment(deferred, "regenerating");
    else {
      const band = room.bands.find((item) => item.resourceType === mineral.resourceType);
      const commitments = room.commitments.filter(
        (item) => item.resourceType === mineral.resourceType,
      );
      const committed = commitments.reduce((sum, item) => sum + positive(item.amount), 0);
      const funded = commitments.reduce((sum, item) => sum + positive(item.fundedAmount), 0);
      const current = roomStock(room, mineral.resourceType);
      const deficit =
        band === undefined ? 0 : Math.max(0, Math.min(band.max, band.target + committed) - current);
      const capacity = [room.storage, room.terminal].reduce(
        (sum, store) => sum + (store?.active === true ? positive(store.freeCapacity) : 0),
        0,
      );
      const amount = Math.floor(Math.min(deficit, funded, mineral.amount, capacity));
      if (band !== undefined && deficit <= 0) increment(deferred, "stock-limit");
      else if (amount <= 0)
        increment(
          deferred,
          funded <= 0 || band === undefined ? "no-funded-deficit" : "destination-capacity",
        );
      else if (proposals.length >= limit) increment(deferred, "proposal-limit");
      else
        proposals.push({
          amount,
          identity:
            "industry/extract/" + room.roomName + "/" + mineral.id + "/" + mineral.resourceType,
          mineralId: mineral.id,
          resourceType: mineral.resourceType,
          roomName: room.roomName,
        });
    }
  }
  return proposals;
}

function planSends(
  requests: readonly InternalSendRequest[],
  rooms: ReadonlyMap<string, MutableRoom>,
  terminalSendBlockedRoomNames: ReadonlySet<string>,
  tick: number,
  limit: number,
  transactionCost: IndustryPlannerInput["transactionCost"],
  deferred: Map<IndustryDeferralReason, number>,
): TerminalSendProposal[] {
  const proposals: TerminalSendProposal[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    const source = rooms.get(request.sourceRoom);
    const destination = rooms.get(request.destinationRoom);
    let reason: IndustryDeferralReason | undefined;
    if (seen.has(request.id)) reason = "duplicate-request";
    else if (
      terminalSendBlockedRoomNames.has(request.sourceRoom) ||
      terminalSendBlockedRoomNames.has(request.destinationRoom)
    )
      reason = "terminal-reserved";
    else if (request.deadline < tick) reason = "expired";
    else if (proposals.length >= limit) reason = "proposal-limit";
    else if (source === undefined) reason = "missing-source";
    else if (destination === undefined) reason = "missing-destination";
    else if (source.room.controllerLevel < 6 || destination.room.controllerLevel < 6)
      reason = "rcl";
    else if (source.room.terminal === null) reason = "missing-source";
    else if (destination.room.terminal === null) reason = "missing-destination";
    else if (!source.room.terminal.active || !destination.room.terminal.active) reason = "inactive";
    else if (source.room.terminal.cooldown > 0 || source.terminalUsed) reason = "cooldown";
    seen.add(request.id);
    if (reason !== undefined || source === undefined || destination === undefined) {
      increment(deferred, reason ?? "missing-source");
      continue;
    }
    const sourceBand = source.bands.get(request.resourceType);
    const destinationBand = destination.bands.get(request.resourceType);
    if (sourceBand === undefined || destinationBand === undefined) {
      increment(deferred, "stock-limit");
      continue;
    }
    const destinationCapacity = Math.min(
      destinationBand.max - (destination.totalStocks.get(request.resourceType) ?? 0),
      destination.terminalFree,
    );
    const upper = Math.floor(
      Math.min(
        positive(request.amount),
        (source.totalStocks.get(request.resourceType) ?? 0) - sourceBand.min,
        source.terminalStocks.get(request.resourceType) ?? 0,
        destinationCapacity,
      ),
    );
    if (upper <= 0) {
      increment(
        deferred,
        destinationCapacity <= 0 ? "destination-capacity" : "insufficient-resource",
      );
      continue;
    }
    const amount = affordable(request, source, upper, transactionCost);
    if (amount <= 0) {
      increment(deferred, "insufficient-energy");
      continue;
    }
    const cost = costOf(transactionCost(amount, request.sourceRoom, request.destinationRoom));
    subtract(source.totalStocks, request.resourceType, amount);
    subtract(source.terminalStocks, request.resourceType, amount);
    subtract(source.totalStocks, ENERGY, cost);
    subtract(source.terminalStocks, ENERGY, cost);
    add(destination.totalStocks, request.resourceType, amount);
    add(destination.terminalStocks, request.resourceType, amount);
    destination.terminalFree -= amount;
    source.terminalUsed = true;
    proposals.push({
      amount,
      deadline: request.deadline,
      destinationRoom: request.destinationRoom,
      identity:
        "industry/send/" +
        request.id +
        "/" +
        request.sourceRoom +
        "/" +
        request.destinationRoom +
        "/" +
        request.resourceType,
      requestId: request.id,
      resourceType: request.resourceType,
      sourceRoom: request.sourceRoom,
      transactionEnergy: cost,
    });
  }
  return proposals;
}

function affordable(
  request: InternalSendRequest,
  source: MutableRoom,
  upper: number,
  transactionCost: IndustryPlannerInput["transactionCost"],
): number {
  const reserve = Math.max(source.room.protectedEnergy, source.bands.get(ENERGY)?.min ?? 0);
  const roomEnergy = source.totalStocks.get(ENERGY) ?? 0;
  const terminalEnergy = source.terminalStocks.get(ENERGY) ?? 0;
  let low = 1;
  let high = upper;
  let result = 0;
  while (low <= high) {
    const amount = Math.floor((low + high) / 2);
    const required =
      costOf(transactionCost(amount, request.sourceRoom, request.destinationRoom)) +
      (request.resourceType === ENERGY ? amount : 0);
    if (required <= terminalEnergy && required <= roomEnergy - reserve) {
      result = amount;
      low = amount + 1;
    } else high = amount - 1;
  }
  return result;
}

function mutableRoom(room: IndustryRoomState): MutableRoom {
  const totalStocks = new Map<string, number>();
  for (const store of [room.storage, room.terminal])
    for (const stock of store?.stocks ?? [])
      add(totalStocks, stock.resourceType, positive(stock.amount));
  return {
    bands: new Map(
      [...room.bands]
        .sort((a, b) => compare(a.resourceType, b.resourceType))
        .map((band) => [band.resourceType, band]),
    ),
    room,
    terminalFree: positive(room.terminal?.freeCapacity ?? 0),
    terminalStocks: new Map(
      (room.terminal?.stocks ?? []).map((stock) => [stock.resourceType, positive(stock.amount)]),
    ),
    terminalUsed: false,
    totalStocks,
  };
}
function roomStock(room: IndustryRoomState, resourceType: string): number {
  return [room.storage, room.terminal].reduce(
    (sum, store) =>
      sum +
      (store?.stocks
        .filter((item) => item.resourceType === resourceType)
        .reduce((subtotal, item) => subtotal + positive(item.amount), 0) ?? 0),
    0,
  );
}
function increment(
  map: Map<IndustryDeferralReason, number>,
  reason: IndustryDeferralReason,
  amount = 1,
): void {
  if (amount > 0) map.set(reason, (map.get(reason) ?? 0) + amount);
}
function add(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}
function subtract(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) - amount);
}
function costOf(value: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.ceil(value) : Number.MAX_SAFE_INTEGER;
}
function positive(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
function integer(value: number): number {
  return Math.floor(positive(value));
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
