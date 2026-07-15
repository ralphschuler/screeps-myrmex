import { MAX_RESERVATION_ID_CODE_UNITS, type BudgetRequest } from "./contracts";

/** Canonical, reversible formatting shared by ledger issuance and persistent-owner validation. */
export function formatReservationId(
  request: Pick<BudgetRequest, "colonyId" | "category" | "issuer" | "revision">,
): string {
  const reservationId = `reservation/${String(request.colonyId.length)}:${request.colonyId}/${request.category}/${String(request.issuer.length)}:${request.issuer}/${String(request.revision)}`;
  if (reservationId.length > MAX_RESERVATION_ID_CODE_UNITS) {
    throw new RangeError(
      `reservation id exceeds the structural cap of ${String(MAX_RESERVATION_ID_CODE_UNITS)} code units`,
    );
  }
  return reservationId;
}
