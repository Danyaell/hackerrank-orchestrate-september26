import { createHash } from "node:crypto";
import { forecastPolicy, sensitivityForecastPolicy, recurrencePolicy, sortIssues } from "../config.js";
import { Money } from "../core/money.js";
import type { FxIndex } from "../core/fx.js";
import type { DateOnly } from "../core/dates.js";
import { analyzeRecurrence, ExactRatio, normalizeDescription, observationMatches } from "./recurrence.js";
import type { FinancialForecast, FinancialState, ForecastIssue, ForecastMovement, ForecastObligation, FxConversion, Provenance, RecurrenceResult, RecurrenceSeries } from "../domain.js";

const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const movementId = (...properties: readonly string[]): string => "movement-" + createHash("sha256").update(JSON.stringify(properties)).digest("hex");
/** Only terminating safety estimates can cross into Money; no rounded mean fallback. */
function sourceEstimate(series: RecurrenceSeries): Money {
  if (series.estimatedAmount.currency !== series.currency) throw new Error("Safety estimate currency differs from series");
  const ratio = ExactRatio.fromAmount(series.estimatedAmount);
  if (ratio.numerator < 0n) throw new Error("Negative safety estimate");
  let divisor = ratio.denominator, twos = 0, fives = 0;
  while (divisor % 2n === 0n) { divisor /= 2n; twos++; }
  while (divisor % 5n === 0n) { divisor /= 5n; fives++; }
  if (divisor !== 1n) throw new Error("Non-terminating safety estimate");
  const scale = Math.max(twos, fives);
  const text = (ratio.numerator * 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives)).toString().padStart(scale + 1, "0");
  return Money.fromNonNegativeDecimalString(scale === 0 ? text : text.slice(0, -scale) + "." + text.slice(-scale), series.currency);
}
function advance(date: DateOnly, series: RecurrenceSeries): DateOnly {
  return series.schedule.kind === "calendar_monthly" ? date.addCalendarMonths(1, series.schedule.anchorDay!, series.schedule.monthEnd) : date.addDays(series.schedule.intervalDays!);
}
const speculativeCredit = /\b(bonus|bonuses|commission|commissions|reimbursement|reimbursements|windfall|lottery|jackpot)\b/;

export function buildForecast(state: FinancialState, fx: FxIndex, analysis: RecurrenceResult = analyzeRecurrence(state)): FinancialForecast {
  return constructForecast(state, fx, analysis, forecastPolicy);
}
export function buildDiagnosticForecast(state: FinancialState, fx: FxIndex, analysis: RecurrenceResult = analyzeRecurrence(state), horizonDays: number = sensitivityForecastPolicy.horizonDays): FinancialForecast {
  return constructForecast(state, fx, analysis, { ...sensitivityForecastPolicy, horizonDays, version: horizonDays === sensitivityForecastPolicy.horizonDays ? sensitivityForecastPolicy.version : "custom_diagnostic_horizon_" + horizonDays });
}
function constructForecast(state: FinancialState, fx: FxIndex, analysis: RecurrenceResult, policy: { readonly version: string; readonly horizonDays: number; readonly usage: FinancialForecast["policyUsage"] }): FinancialForecast {
  const horizonDays = policy.horizonDays;
  const issues: ForecastIssue[] = [], movements: ForecastMovement[] = [], suppressed: ForecastMovement[] = [], obligations: ForecastObligation[] = [];
  const excludedCredits = new Set(state.pendingCreditClaims.map((record) => record.event.id));
  const start = state.request.date;
  let end = start;
  const issue = (code: string, effect: ForecastIssue["effect"], id: string, provenance: readonly Provenance[], explanation: string, field = "amount"): void => {
    const source = provenance[0] ?? state.request.source;
    issues.push(Object.freeze({ ...source, severity: effect === "blocking" ? "error" : "warning", code, field, effect, obligationId: id, provenance: Object.freeze([...provenance]), explanation }));
  };
  try {
    if (!Number.isSafeInteger(horizonDays) || horizonDays < 0) throw new Error("Invalid horizon");
    end = start.addDays(horizonDays);
  } catch { issue("FORECAST_HORIZON_RANGE", "blocking", state.request.id, [state.request.source], "Horizon exceeds supported Gregorian dates or is invalid", "request_date"); }
  const inHorizon = (date: DateOnly): boolean => date.compare(start) >= 0 && date.compare(end) <= 0;
  const unresolved = (id: string, knownAmount: Money | null, date: DateOnly | null, eventIds: readonly string[], seriesId: string | null, provenance: readonly Provenance[], reason: string): void => {
    obligations.push(Object.freeze({ id, knownAmount, date, sourceEventIds: Object.freeze([...eventIds]), seriesId, provenance: Object.freeze([...provenance]), reason }));
  };
  const make = (id: string, date: DateOnly, original: Money, conversion: FxConversion, kind: ForecastMovement["kind"], operation: ForecastMovement["operation"], obligationId: string,
    eventIds: readonly string[], seriesId: string | null, provenance: readonly Provenance[], confidence: ForecastMovement["confidence"], evidenceState: ForecastMovement["evidenceState"], rationale: string): ForecastMovement => Object.freeze({
      id, date, original, amount: operation === "cash" && kind === "generated_recurring_income" ? conversion.converted : conversion.converted.negate(),
      kind, operation, obligationId, sourceEventIds: Object.freeze([...eventIds]), seriesId, fx: conversion, confidence, evidenceState,
      provenance: Object.freeze([...provenance]), deduplication: Object.freeze({ decision: "retained", rationale, matchedMovementId: null }),
    });
  const recordsById = new Map(state.records.map((record) => [record.event.id, record]));
  // Lifecycle uncertainty is preserved independently of resolved trace amounts.
  for (const group of state.lifecycleGroups.filter((group) => group.ambiguous)) {
    const records = group.memberIds.map((id) => recordsById.get(id)!);
    if (!records.some((record) => record.event.direction === "debit")) continue;
    const provenance = records.map((record) => record.event.source);
    unresolved(group.id, null, null, group.memberIds, null, provenance, "ambiguous_lifecycle_identity");
    issue("FORECAST_AMBIGUOUS_LIFECYCLE", "conservative_unresolved", group.id, provenance, "Lifecycle identity remains ambiguous; distinct debits are not silently merged", "linked_event_id");
  }
  for (const record of state.records) {
    const event = record.event;
    if (["failed", "cancelled", "non_cash", "pending_credit"].includes(record.category) && !record.unresolvedReasons.includes("failed_debt_without_confirmed_retry")) continue;
    if (event.direction !== "debit") continue;
    if (event.amount.kind === "unresolved") {
      unresolved("event:" + event.id, null, event.settlementDate, [event.id], null, [event.source], "missing_debit_amount");
      issue("FORECAST_UNRESOLVED_DEBIT_AMOUNT", "blocking", event.id, [event.source], "Material debit amount is unresolved; no movement or zero was created");
    } else if (record.category === "ambiguous_obligation" || record.unresolvedReasons.includes("failed_debt_without_confirmed_retry")) {
      unresolved("event:" + event.id, event.amount.money, event.settlementDate, [event.id], null, [event.source], "unresolved_obligation_date");
      issue("FORECAST_UNDATED_OBLIGATION", "conservative_unresolved", event.id, [event.source], "Outstanding obligation has no reliable future payment date", "settlement_date");
      const conversion = fx.convert(event.amount.money, state.profile.homeCurrency, event.settlementDate, event.source);
      if (conversion.conversion !== null) movements.push(make(movementId("reserve", event.id), start, event.amount.money, conversion.conversion, "conservative_reserve", "reserve_open", "event:" + event.id, [event.id], null, [event.source], "uncertain", "unresolved", "Reserve known outstanding amount; not realized failed cash"));
      else for (const error of conversion.issues) issue("FORECAST_" + error.code, "blocking", event.id, [event.source], error.explanation, error.field ?? "currency");
    }
  }
  const confirmed = state.records.filter((record) => ["confirmed_future", "same_day_dated"].includes(record.category) && record.cashFact !== null && inHorizon(record.cashFact.date));
  const overlapRecords = [...confirmed, ...state.pendingDebitExposures.filter((record) => record.event.settlementDate !== null && inHorizon(record.event.settlementDate))];
  const pendingSettlements = new Map<string, string>();
  for (const record of state.pendingDebitExposures) {
    const event = record.event;
    if (event.amount.kind !== "resolved" || record.conversion === null) continue;
    const obligation = "pending:" + event.id;
    movements.push(make(movementId("hold-open", event.id), start, event.amount.money, record.conversion, "pending_hold_transition", "hold_open", obligation, [event.id], null, [event.source], "uncertain", "ambiguous", "Snapshot hold treatment is a scenario, never a second debit"));
    const replacements = confirmed.filter((other) => other.event.linkedEventId === event.id && other.event.direction === "debit" &&
      other.event.type === event.type && other.event.raw.category === event.raw.category && other.event.raw.flexibility === event.raw.flexibility &&
      other.event.currency === event.currency && other.event.amount.kind === "resolved" && other.event.amount.money.equals(event.amount.kind === "resolved" ? event.amount.money : other.event.amount.money) &&
      normalizeDescription(other.event.raw.description) === normalizeDescription(event.raw.description) && other.cashFact!.date.equals(event.settlementDate ?? start));
    const settlement = replacements.length === 1 ? replacements[0]!.cashFact!.date : event.settlementDate;
    if (replacements.length === 1) pendingSettlements.set(replacements[0]!.event.id, obligation);
    if (settlement !== null && inHorizon(settlement)) {
      const sources = replacements.length === 1 ? [event.source, replacements[0]!.event.source] : [event.source];
      movements.push(make(movementId("hold-settle", event.id), settlement, event.amount.money, record.conversion, "pending_hold_transition", "hold_settle", obligation,
        replacements.length === 1 ? [event.id, replacements[0]!.event.id] : [event.id], null, sources, replacements.length === 1 ? "confirmed" : "uncertain", "ambiguous",
        "Release reservation and debit the same exposure atomically; tentative date does not increase spendable funds"));
    }
  }
  for (const record of confirmed) {
    const fact = record.cashFact!, event = record.event;
    if (event.amount.kind !== "resolved") continue;
    const uncertainCredit = record.unresolvedReasons.length > 0 || (event.status !== "settled" &&
      (["refund", "investment_sale"].includes(event.type) || speculativeCredit.test((event.raw.category + " " + event.raw.description).replaceAll("_", " ").toLowerCase())));
    if (event.direction === "credit" && uncertainCredit) {
      excludedCredits.add(event.id); continue;
    }
    if (record.category === "same_day_dated" && event.status === "settled") issue("FORECAST_SAME_DAY_SNAPSHOT", "conservative_unresolved", event.id, [event.source], "Same-day settlement may already be in the snapshot; trace includes debit conservatively and excludes credit", "settlement_date");
    if (record.category === "same_day_dated" && event.status === "settled" && event.direction === "credit") { excludedCredits.add(event.id); continue; }
    const movement = Object.freeze({ ...make(movementId("confirmed", fact.id), fact.date, event.amount.money, fact.conversion, "confirmed_future_commitment", "cash", "event:" + event.id, [event.id], null, [event.source], "confirmed", "confirmed", "Distinct supplied cash identity retained"), amount: fact.movement });
    const pending = pendingSettlements.get(event.id);
    if (pending) suppressed.push(Object.freeze({ ...movement, deduplication: Object.freeze({ decision: "suppressed", rationale: "Explicit parent hold plus identical currency, description, amount and date; settlement represented by hold transition", matchedMovementId: movements.find((candidate) => candidate.obligationId === pending && candidate.operation === "hold_settle")!.id }) }));
    else movements.push(movement);
  }
  for (const series of analysis.series) {
    if (series.userId !== state.request.userId) { issue("FORECAST_SERIES_OWNERSHIP", "blocking", series.id, series.provenance, "Recurrence series belongs to another user", "user_id"); continue; }
    const income = series.direction === "credit";
    const supported = series.status === "active" && (income ? series.support === "strong" && series.incomeInferenceEligible && series.observationCount >= recurrencePolicy.minimumIncomeObservations : ["supported", "strong"].includes(series.support) && series.observationCount >= recurrencePolicy.minimumExpenseObservations);
    if (!supported || series.expectedNextOccurrence === null || series.schedule.kind === "unsupported") {
      if (!income) {
        let amount: Money | null = null;
        try { amount = sourceEstimate(series); } catch { /* Preserve unresolved estimate, not zero. */ }
        if (amount?.isZero()) continue;
        unresolved(series.id, amount, null, series.supportingEventIds, series.id, series.provenance, "expense_continuity_requires_review");
        issue("FORECAST_UNCERTAIN_EXPENSE_SERIES", "conservative_unresolved", series.id, series.provenance, "Expense cadence or continuity is unresolved; no unsupported occurrence was invented", "settlement_date");
      }
      continue;
    }
    let original: Money;
    try { original = sourceEstimate(series); } catch {
      unresolved(series.id, null, null, series.supportingEventIds, series.id, series.provenance, "non_terminating_or_invalid_safety_estimate");
      issue("FORECAST_INVALID_SAFETY_ESTIMATE", "blocking", series.id, series.provenance, "Safety estimate is invalid or not an exact terminating decimal"); continue;
    }
    let date = series.expectedNextOccurrence;
    while (date.compare(end) <= 0) {
      if (date.compare(start) >= 0) {
        const candidateId = movementId("recurrence", series.id, date.toISODateString());
        const signature = JSON.parse(series.matchingSignature) as { description: string | null };
        const matches = overlapRecords.filter((record) => record.event.amount.kind === "resolved" && record.event.direction === series.direction && (record.cashFact?.date ?? record.event.settlementDate)!.equals(date) &&
          observationMatches(series.matchingSignature, { eventId: record.event.id, userId: record.event.userId, direction: series.direction, eventType: record.event.type,
            category: record.event.raw.category, description: normalizeDescription(record.event.raw.description), flexibility: record.event.raw.flexibility,
            amount: record.event.amount.money, date: (record.cashFact?.date ?? record.event.settlementDate)!, source: record.event.source }) && !excludedCredits.has(record.event.id) &&
          (signature.description !== null || (record.event.linkedEventId !== null && series.supportingEventIds.includes(record.event.linkedEventId))));
        const conversion = fx.convert(original, state.profile.homeCurrency, date, series.provenance[0]!);
        if (conversion.conversion === null) {
          unresolved(candidateId, original, date, series.supportingEventIds, series.id, series.provenance, "missing_projected_fx");
          for (const error of conversion.issues) issue("FORECAST_PROJECTED_" + error.code, "blocking", candidateId, series.provenance, error.explanation + "; occurrence=" + date.toISODateString(), error.field ?? "currency");
        } else {
          const movement = make(candidateId, date, original, conversion.conversion, income ? "generated_recurring_income" : "generated_recurring_expense", "cash", "series:" + series.id + ":" + date.toISODateString(), series.supportingEventIds, series.id, series.provenance, "supported", "inferred", "No unique supplied obligation with strong signature identity at this schedule position");
          if (matches.length === 1) {
            const matched = movements.find((candidate) => candidate.sourceEventIds.includes(matches[0]!.event.id) && candidate.date.equals(date));
            if (matched) suppressed.push(Object.freeze({ ...movement, deduplication: Object.freeze({ decision: "suppressed", rationale: "Unique user/direction/type/category/source-currency/signature/description identity and schedule date; supplied amount takes precedence", matchedMovementId: matched.id }) }));
            else movements.push(movement);
          } else {
            movements.push(movement);
            if (matches.length > 1) {
              unresolved(candidateId, original, date, matches.map((record) => record.event.id), series.id, series.provenance, "multiple_overlap_candidates");
              issue("FORECAST_AMBIGUOUS_OVERLAP", "conservative_unresolved", candidateId, series.provenance, "Multiple supplied obligations match; none was silently deduplicated", "event_id");
            }
          }
        }
      }
      try { const next = advance(date, series); if (next.compare(date) <= 0) throw new Error("Non-advancing cadence"); date = next; }
      catch { if (date.compare(end) < 0) issue("FORECAST_SCHEDULE_RANGE", "blocking", series.id, series.provenance, "Schedule cannot advance within the horizon", "settlement_date"); break; }
    }
  }
  const compare = (a: ForecastMovement, b: ForecastMovement): number => a.date.compare(b.date) || lexical(a.id, b.id);
  const ids = new Set<string>();
  for (const movement of movements) { if (ids.has(movement.id)) issue("FORECAST_DUPLICATE_MOVEMENT", "blocking", movement.id, movement.provenance, "Movement identity is duplicated", "event_id"); ids.add(movement.id); }
  const sortedIssues = sortIssues(issues) as readonly ForecastIssue[];
  return Object.freeze({ requestId: state.request.id, userId: state.request.userId, currency: state.profile.homeCurrency, start, end,
    policyVersion: policy.version, policyUsage: policy.usage, policyHash: createHash("sha256").update(JSON.stringify({ ...forecastPolicy, ...policy })).digest("hex"), recurrencePolicyHash: analysis.policyHash,
    movements: Object.freeze(movements.sort(compare)), suppressedMovements: Object.freeze(suppressed.sort(compare)), unresolvedObligations: Object.freeze(obligations.sort((a, b) => lexical(a.id, b.id))),
    issues: sortedIssues, excludedCreditEventIds: Object.freeze([...excludedCredits].sort(lexical)) });
}
