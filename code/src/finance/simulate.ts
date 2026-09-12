import { Money } from "../core/money.js";
import { sortIssues } from "../config.js";
import { movementId } from "./forecast.js";
import type { BalanceCheckpoint, DailyTrace, DiagnosticInjection, FinancialForecast, FinancialState, ForecastMovement, Issue, PendingScenario, SameDayOrder, SimulationTrace } from "../domain.js";

const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
/** Opening reserves, then diagnostic debits, then the explicitly chosen cash phases. */
export function movementPhase(movement: ForecastMovement, ordering: SameDayOrder): number {
  if (["hold_open", "reserve_open"].includes(movement.operation)) return 0;
  const debit = movement.amount.compare(Money.fromDecimalString("0", movement.amount.currency)) < 0;
  if (movement.kind === "injected_diagnostic_payment" && debit) return 1;
  return ordering === "debits_before_credits" ? debit ? 2 : 3 : debit ? 3 : 2;
}

export function simulate(state: FinancialState, forecast: FinancialForecast, pendingScenario: PendingScenario, sameDayOrder: SameDayOrder, injections: readonly DiagnosticInjection[] = []): SimulationTrace {
  const currency = state.profile.homeCurrency, zero = Money.fromDecimalString("0", currency);
  const issues: Issue[] = [], days: DailyTrace[] = [], checkpoints: BalanceCheckpoint[] = [];
  const fail = (code: string, explanation: string, movement?: ForecastMovement): void => {
    issues.push(Object.freeze({ ...(movement?.provenance[0] ?? state.request.source), severity: "error", code, field: "amount", explanation }));
  };
  if (forecast.requestId !== state.request.id || forecast.userId !== state.request.userId || forecast.currency !== currency || !forecast.start.equals(state.request.date)) fail("SIM_FORECAST_MISMATCH", "Forecast ownership, currency or request boundary differs from state");
  if (!["includes_holds", "excludes_holds"].includes(pendingScenario) || !["debits_before_credits", "credits_before_debits"].includes(sameDayOrder)) fail("SIM_INVALID_SCENARIO", "Unknown simulation scenario");
  const all = [...forecast.movements];
  for (const injection of injections) all.push(Object.freeze({
    id: movementId("diagnostic", state.request.id, injection.id, injection.date.toISODateString()), date: injection.date, amount: injection.amount, original: injection.amount,
    kind: "injected_diagnostic_payment", operation: "cash", obligationId: "diagnostic:" + injection.id, sourceEventIds: Object.freeze([]), seriesId: null, fx: null,
    confidence: "confirmed", evidenceState: "confirmed", provenance: Object.freeze([injection.source]),
    deduplication: Object.freeze({ decision: "retained", rationale: "Explicit diagnostic input, no payment plan generated", matchedMovementId: null }),
  }));
  const seen = new Set<string>(), byDate = new Map<string, ForecastMovement[]>();
  for (const movement of all) {
    if (seen.has(movement.id)) { fail("SIM_DUPLICATE_MOVEMENT", "Movement identity cannot be applied twice", movement); continue; }
    seen.add(movement.id);
    if (movement.amount.currency !== currency) { fail("SIM_CURRENCY_MISMATCH", "Movement must use the home currency", movement); continue; }
    if (movement.date.compare(forecast.start) < 0 || movement.date.compare(forecast.end) > 0) { fail("SIM_DATE_OUTSIDE_HORIZON", "Movement or diagnostic injection is outside the horizon", movement); continue; }
    if (movement.deduplication.decision !== "retained") { fail("SIM_SUPPRESSED_MOVEMENT", "Suppressed movement cannot enter the ledger", movement); continue; }
    const key = movement.date.toISODateString(), bucket = byDate.get(key) ?? []; bucket.push(movement); byDate.set(key, bucket);
  }
  let ledger = state.startingBalance, held = zero;
  const holds = new Map<string, { amount: Money; settled: boolean }>();
  const checkpoint = (date: DailyTrace["date"], phase: BalanceCheckpoint["phase"], movement: ForecastMovement | null): BalanceCheckpoint => {
    const spendable = ledger.subtract(held);
    const result = Object.freeze({ id: movement?.id ?? phase + ":" + date.toISODateString(), date, phase, ledgerBalance: ledger, heldAmount: held, spendableBalance: spendable,
      movement, margin: spendable.subtract(state.profile.minimumBalance) });
    checkpoints.push(result); return result;
  };
  for (let date = forecast.start; date.compare(forecast.end) <= 0; ) {
    const dayCheckpoints: BalanceCheckpoint[] = [], openingBalance = ledger, openingSpendable = ledger.subtract(held);
    dayCheckpoints.push(checkpoint(date, "opening", null));
    const ordered = [...(byDate.get(date.toISODateString()) ?? [])].sort((a, b) => movementPhase(a, sameDayOrder) - movementPhase(b, sameDayOrder) || lexical(a.id, b.id));
    for (const movement of ordered) {
      const amount = movement.amount.negate();
      if (movement.operation === "hold_open") {
        if (movement.date.compare(forecast.start) !== 0 || movement.amount.compare(zero) > 0 || holds.has(movement.obligationId)) { fail("SIM_INVALID_HOLD_OPEN", "Hold must open once at the request boundary with a debit exposure", movement); continue; }
        holds.set(movement.obligationId, { amount, settled: false }); held = held.add(amount);
        // Accounting gross-up only: no available income is created in includes_holds.
        if (pendingScenario === "includes_holds") ledger = ledger.add(amount);
      } else if (movement.operation === "hold_settle") {
        const hold = holds.get(movement.obligationId);
        if (!hold || hold.settled || !hold.amount.equals(amount)) { fail("SIM_INVALID_HOLD_SETTLEMENT", "Hold settlement requires one matching open, unsettled exposure", movement); continue; }
        hold.settled = true;
        // Atomic transition: never expose the released hold as spendable credit.
        ledger = ledger.add(movement.amount); held = held.subtract(amount);
      } else if (movement.operation === "reserve_open") {
        if (movement.amount.compare(zero) > 0) { fail("SIM_INVALID_RESERVE", "Conservative reserve cannot create available cash", movement); continue; }
        held = held.add(amount);
      } else ledger = ledger.add(movement.amount);
      const phase: BalanceCheckpoint["phase"] = movementPhase(movement, sameDayOrder) === 0 ? "reserve" : movementPhase(movement, sameDayOrder) === 1 ? "payment" : "cash";
      dayCheckpoints.push(checkpoint(date, phase, movement));
    }
    dayCheckpoints.push(checkpoint(date, "closing", null));
    const minimum = dayCheckpoints.reduce((value, point) => value.minimum(point.spendableBalance), openingSpendable);
    days.push(Object.freeze({ date, openingBalance, openingSpendable, heldAmount: held, spendableBalance: ledger.subtract(held), checkpoints: Object.freeze(dayCheckpoints), closingBalance: ledger, minimumBalance: minimum }));
    if (date.equals(forecast.end)) break;
    date = date.addDays(1);
  }
  const minimumCheckpoint = checkpoints.reduce((value, point) => point.spendableBalance.compare(value.spendableBalance) < 0 ? point : value, checkpoints[0]!);
  const accounting = new Map([...holds].map(([id, value]) => [id, Object.freeze({ opened: true, settled: value.settled })]));
  return Object.freeze({ requestId: state.request.id, forecastPolicyHash: forecast.policyHash, pendingScenario, sameDayOrder, days: Object.freeze(days), checkpoints: Object.freeze(checkpoints),
    minimumCheckpoint, minimumBalance: minimumCheckpoint.spendableBalance, breaches: Object.freeze(checkpoints.filter((point) => point.margin.compare(zero) < 0)), issues: sortIssues(issues), pendingAccounting: accounting });
}
