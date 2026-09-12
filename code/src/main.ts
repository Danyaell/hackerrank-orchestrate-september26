import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatasetArgument, parseStateArguments, productionFiles, sortIssues } from "./config.js";
import { loadProduction } from "./data/load.js";
import { buildIndexes } from "./data/indexes.js";
import type { InspectionResult, Issue, TableName } from "./domain.js";
import type { FinancialState, StateResult } from "./domain.js";
import { normalizeData } from "./data/normalize.js";
import { reconstructState } from "./finance/state.js";
import { analyzeRecurrence, ExactRatio } from "./finance/recurrence.js";
import { buildForecast } from "./finance/forecast.js";
import { calculateCapacity } from "./finance/capacity.js";

export function printReport(result: InspectionResult, mode: string, extraFiles: readonly string[] = []): void {
  console.log("Buy or Wait? — " + mode + " (raw structure only)");
  console.log("Runtime: " + process.version);
  console.log("Files loaded: " + [...result.filesLoaded, ...extraFiles].join(", "));
  console.log("Active requests: " + result.indexes.requestsById.size);
  console.log("Table | loaded | valid | active | ignored | invalid");
  for (const table of Object.keys(productionFiles) as TableName[]) {
    const count = result.counts[table];
    console.log([table, count.loaded, count.valid, count.active, count.ignored, count.invalid].join(" | "));
  }
  console.log("Index sizes: " + Object.entries(result.indexes).map(([name, index]) => name + "=" + index.size).join(", "));
  printIssues(result.issues);
}

export function printIssues(issues: readonly Issue[]): void {
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const errors = issues.filter((issue) => issue.severity === "error").length;
  console.log("Warnings: " + warnings + "; Errors: " + errors);
  // Source text and field values are never printed.
  for (const issue of issues) {
    console.log([
      issue.severity.toUpperCase(), issue.code, issue.filename,
      "row=" + (issue.row ?? "file"), "field=" + (issue.field ?? "-"),
      "id=" + (issue.recordId ?? "-"), issue.explanation,
    ].join(" | "));
  }
  console.log(errors === 0 ? "Result: SUCCESS" : "Result: FAILURE");
}

export async function runInspection(args: readonly string[]): Promise<number> {
  if (args[0] !== "inspect") throw new Error("Usage: node main.js inspect [--dataset <directory>]");
  const datasetDirectory = parseDatasetArgument(args.slice(1));
  const loaded = await loadProduction(datasetDirectory);
  const result = await buildIndexes(loaded, datasetDirectory);
  printReport(result, "production inspection");
  return result.issues.some((issue) => issue.severity === "error") ? 1 : 0;
}

export function stateCounts(state: FinancialState): Readonly<Record<string, number>> {
  return Object.freeze({
    source_records: state.records.length,
    historical_cash_facts: state.historicalCashFacts.length,
    confirmed_future_commitments: state.confirmedFutureCommitments.length,
    same_day_cash_facts: state.sameDayCashFacts.length,
    pending_debit_exposures: state.pendingDebitExposures.length,
    pending_credit_claims: state.pendingCreditClaims.length,
    failed_attempts: state.failedAttempts.length,
    cancelled_attempts: state.cancelledAttempts.length,
    non_cash_records: state.nonCashRecords.length,
    lifecycle_groups: state.lifecycleGroups.length,
    ambiguous_lifecycle_groups: state.lifecycleGroups.filter((group) => group.ambiguous).length,
    ambiguous_obligations: state.ambiguousObligations.length,
    unresolved_records: state.unresolvedRecords.length,
    unresolved_amounts: state.records.filter((record) => record.event.amount.kind === "unresolved").length,
    foreign_cash_records_converted: state.records.filter((record) => record.conversion?.rate !== null && record.conversion !== null).length,
    unresolved_foreign_cash_amounts: state.records.filter((record) => record.event.currency !== state.profile.homeCurrency &&
      record.event.amount.kind === "unresolved" && !["failed", "cancelled", "non_cash"].includes(record.category)).length,
  });
}

export async function runStateInspection(args: readonly string[]): Promise<number> {
  const all = args[0] === "inspect-states";
  const { datasetDirectory, requestId } = parseStateArguments(args.slice(1), !all);
  const inspection = await buildIndexes(await loadProduction(datasetDirectory), datasetDirectory);
  if (inspection.issues.some((issue) => issue.severity === "error")) {
    printReport(inspection, "blocking ingestion diagnostics");
    return 1;
  }
  const normalized = normalizeData(inspection);
  const requestIds = all ? [...normalized.requests.keys()].sort() : [requestId!];
  const results: StateResult[] = requestIds.map((id) => reconstructState(normalized, id));
  const uniqueIssues = new Map(results.flatMap((result) => result.issues).map((issue) => [
    JSON.stringify([issue.severity, issue.code, issue.filename, issue.row, issue.field, issue.recordId, issue.explanation]), issue,
  ]));
  const issues = sortIssues([...uniqueIssues.values()]);
  console.log("Buy or Wait? — " + (all ? "all-request state diagnostics" : "request state inspection") + " (no forecasting or decisions)");
  console.log("Runtime: " + process.version + "; pending balance policy: unknown; same-day ordering: unresolved");
  console.log("Requests attempted: " + requestIds.length + "; successfully reconstructed: " + results.filter((result) => result.state !== null).length);
  console.log("Blocking requests: " + results.filter((result) => result.state === null).length +
    "; blocking errors: " + issues.filter((issue) => issue.severity === "error").length);
  const aggregate: Record<string, number> = {};
  for (const result of results) {
    if (result.state === null) continue;
    for (const [key, count] of Object.entries(stateCounts(result.state))) aggregate[key] = (aggregate[key] ?? 0) + count;
    if (!all) {
      console.log("Request: " + result.state.request.id + "; date: " + result.state.request.date.toISODateString());
      console.log("Home currency: " + result.state.profile.homeCurrency + "; source currencies: " +
        [...new Set(result.state.records.map((record) => record.event.currency))].sort().join(", "));
      console.log("Starting snapshot: " + result.state.startingBalance.toExactDecimalString() + "; historical facts were not replayed");
      for (const group of result.state.lifecycleGroups) console.log("Lifecycle: " + group.memberIds.join(", ") +
        "; relationships=" + group.edges.map((edge) => edge.kind).join(", ") + "; ambiguous=" + group.ambiguous);
    }
  }
  for (const [key, count] of Object.entries(aggregate)) console.log(key + ": " + count);
  console.log("missing_fx_rates: " + issues.filter((issue) => issue.code === "FX_MISSING_RATE" || issue.code === "FX_WRONG_DIRECTION").length);
  printIssues(issues);
  return issues.some((issue) => issue.severity === "error") ? 1 : 0;
}

export async function runRecurrenceInspection(args: readonly string[]): Promise<number> {
  const { datasetDirectory, requestId } = parseStateArguments(args, true);
  const inspection = await buildIndexes(await loadProduction(datasetDirectory), datasetDirectory);
  if (inspection.issues.some((issue) => issue.severity === "error")) { printReport(inspection, "blocking ingestion diagnostics"); return 1; }
  const result = reconstructState(normalizeData(inspection), requestId!);
  if (result.state === null) { printIssues(result.issues); return 1; }
  const analysis = analyzeRecurrence(result.state);
  console.log("Buy or Wait? — recurrence candidates only; no cash-flow forecast or decisions");
  console.log("Runtime: " + process.version + "; policy=" + analysis.policyVersion + "; hash=" + analysis.policyHash);
  console.log("Request: " + result.state.request.id + "; cutoff=" + result.state.request.date.toISODateString());
  console.log("Eligible observations: " + analysis.observations.length + "; excluded records: " + analysis.exclusions.length + "; candidate series: " + analysis.series.length);
  for (const series of analysis.series) console.log(JSON.stringify({
    series_id: series.id, direction: series.direction, event_type: series.eventType, category: series.category, currency: series.currency,
    grouping: series.groupingPolicy, supporting_count: series.observationCount, schedule: series.schedule.kind,
    reference_amount: ExactRatio.fromAmount(series.referenceAmount).toFractionString(), reference_use: series.referenceAmountUse,
    activity_policy: series.activityPolicy, activity_confidence: series.activityConfidence,
    income_inference_eligible: series.incomeInferenceEligible, expense_continuity: series.expenseContinuity,
    anchor_day: series.schedule.anchorDay, month_end: series.schedule.monthEnd, interval_days: series.schedule.intervalDays,
    amount_model: series.amountModel, amount_behavior: series.amountBehavior, amount_exact_fraction: ExactRatio.fromAmount(series.estimatedAmount).toFractionString(),
    next_occurrence: series.expectedNextOccurrence?.toISODateString() ?? null, status: series.status, support: series.support,
    missed_occurrences: series.missedOccurrences, supplied_future_references: series.suppliedFutureEventIds, diagnostics: series.diagnostics,
  }));
  const reasons: Record<string, number> = {};
  for (const exclusion of analysis.exclusions) for (const reason of exclusion.reasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
  console.log("Exclusion counts: " + JSON.stringify(Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
  printIssues(result.issues);
  return 0;
}

export async function runForecastInspection(args: readonly string[]): Promise<number> {
  const all = args[0] === "inspect-capacities";
  const { datasetDirectory, requestId } = parseStateArguments(args.slice(1), !all);
  const inspection = await buildIndexes(await loadProduction(datasetDirectory), datasetDirectory);
  if (inspection.issues.some((issue) => issue.severity === "error")) { printReport(inspection, "blocking ingestion diagnostics"); return 1; }
  const normalized = normalizeData(inspection);
  const ids = all ? [...normalized.requests.keys()].sort() : [requestId!];
  const issues: Issue[] = [];
  const counts: Record<string, number> = {
    requests_processed: 0, valid_baseline_capacities: 0, baselines_already_below_minimum: 0,
    blocked_capacities: 0, conservative_unresolved_capacities: 0, missing_projected_fx_rates: 0,
    pending_hold_sensitive_requests: 0, same_day_order_sensitive_requests: 0,
    generated_recurring_movements: 0, confirmed_future_movements: 0, suppressed_overlap_movements: 0,
    ambiguous_or_unresolved_forecast_obligations: 0, earliest_full_payment_dates_found: 0, earliest_full_payment_dates_missing: 0,
  };
  console.log("Buy or Wait? — baseline financial diagnostics only; no recommendations");
  console.log("Runtime: " + process.version);
  for (const id of ids) {
    counts.requests_processed!++;
    const result = reconstructState(normalized, id);
    if (result.state === null) { issues.push(...result.issues); counts.blocked_capacities!++; counts.earliest_full_payment_dates_missing!++; continue; }
    const forecast = buildForecast(result.state, normalized.fx);
    const capacity = calculateCapacity(result.state, forecast);
    issues.push(...capacity.issues);
    if (capacity.status === "valid") counts.valid_baseline_capacities!++;
    if (capacity.status === "blocked") counts.blocked_capacities!++;
    if (capacity.status === "conservative_unresolved") counts.conservative_unresolved_capacities!++;
    if (capacity.baselineTraces.some((trace) => trace.breaches.length > 0)) counts.baselines_already_below_minimum!++;
    if (capacity.pendingSensitive) counts.pending_hold_sensitive_requests!++;
    if (capacity.sameDaySensitive) counts.same_day_order_sensitive_requests!++;
    counts.missing_projected_fx_rates! += forecast.issues.filter((issue) => /FORECAST_PROJECTED_FX_(MISSING_RATE|WRONG_DIRECTION)$/.test(issue.code)).length;
    counts.generated_recurring_movements! += forecast.movements.filter((movement) => movement.kind.startsWith("generated_recurring_")).length;
    counts.confirmed_future_movements! += forecast.movements.filter((movement) => movement.kind === "confirmed_future_commitment").length;
    counts.suppressed_overlap_movements! += forecast.suppressedMovements.length;
    counts.ambiguous_or_unresolved_forecast_obligations! += forecast.unresolvedObligations.length;
    counts[capacity.earliestFullPaymentDate === null ? "earliest_full_payment_dates_missing" : "earliest_full_payment_dates_found"]!++;
    if (!all || counts.requests_processed === 1) console.log("Horizon: " + forecast.start.toISODateString() + " through " + forecast.end.toISODateString() + " inclusive; policy=" + forecast.policyVersion + "; hash=" + forecast.policyHash + "; recurrence=" + forecast.recurrencePolicyHash);
    if (!all) {
      console.log(JSON.stringify({ request_id: id, currency: forecast.currency, status: capacity.status,
        maximum_immediate_payment: capacity.maximumImmediatePayment?.toExactDecimalString() ?? null,
        earliest_full_payment_date: capacity.earliestFullPaymentDate?.toISODateString() ?? null,
        limiting_scenario: capacity.limitingScenario, limiting_date: capacity.limitingCheckpoint?.date.toISODateString() ?? null,
        limiting_checkpoint: capacity.limitingCheckpoint?.id ?? null, margin: capacity.margin?.toExactDecimalString() ?? null,
        unresolved_obligations: forecast.unresolvedObligations.length, excluded_credit_claims: forecast.excludedCreditEventIds.length }));
      for (const trace of capacity.baselineTraces) console.log(JSON.stringify({ pending_scenario: trace.pendingScenario, same_day_order: trace.sameDayOrder,
        days: trace.days.length, checkpoints: trace.checkpoints.length, minimum_balance: trace.minimumBalance.toExactDecimalString(), breaches: trace.breaches.length }));
      if (args[0] === "inspect-forecast") for (const movement of [...forecast.movements, ...forecast.suppressedMovements]) console.log(JSON.stringify({
        movement_id: movement.id, date: movement.date.toISODateString(), kind: movement.kind, operation: movement.operation,
        amount: movement.amount.toExactDecimalString(), currency: movement.amount.currency, source_currency: movement.original.currency,
        source_event_ids: movement.sourceEventIds, recurrence_series_id: movement.seriesId,
        deduplication: movement.deduplication, fx_rate_date: movement.fx?.rateDate?.toISODateString() ?? null,
      }));
    }
  }
  for (const [key, count] of Object.entries(counts)) console.log(key + ": " + count);
  console.log("Missing earliest dates include blocked/unresolved requests; they do not prove impossibility. Order sensitivity compares daily checkpoint minima.");
  const unique = new Map(issues.map((issue) => [JSON.stringify(issue), issue]));
  const ordered = sortIssues([...unique.values()]);
  printIssues(ordered);
  return ordered.some((issue) => issue.severity === "error") ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    process.exitCode = ["inspect-forecast", "inspect-capacity", "inspect-capacities"].includes(args[0] ?? "") ? await runForecastInspection(args) : args[0] === "inspect-recurrence" ? await runRecurrenceInspection(args.slice(1)) : args[0] === "inspect-state" || args[0] === "inspect-states" ?
      await runStateInspection(args) : await runInspection(args);
  } catch {
    console.error("CLI_ERROR: invalid arguments or unexpected inspection failure. Use inspect, inspect-state, inspect-states, inspect-recurrence, inspect-forecast, inspect-capacity, or inspect-capacities with --dataset <directory> and --request <id> where required; ambiguous paths require an absolute path.");
    process.exitCode = 1;
  }
}
