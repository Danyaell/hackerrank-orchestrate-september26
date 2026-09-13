import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatasetArgument, parseStateArguments, planPolicy, productionFiles, sortIssues } from "./config.js";
import { createHash } from "node:crypto";
import { loadProduction } from "./data/load.js";
import { buildIndexes } from "./data/indexes.js";
import type { InspectionResult, Issue, TableName } from "./domain.js";
import type { BaselineCapacity, FinancialState, StateResult } from "./domain.js";
import { Money } from "./core/money.js";
import { normalizeData } from "./data/normalize.js";
import { reconstructState } from "./finance/state.js";
import { analyzeRecurrence, ExactRatio } from "./finance/recurrence.js";
import { buildForecast, buildDiagnosticForecast } from "./finance/forecast.js";
import { calculateCapacity, calculateDiagnosticCapacity } from "./finance/capacity.js";
import { selectPlans } from "./finance/plans.js";
import { actionText } from "./finance/spending.js";
import type { InternalPaymentPlan } from "./domain.js";

function planMetadata(plan: InternalPaymentPlan): object {
  return { id: plan.id, method: plan.method, option_id: plan.optionId, currency: plan.totalPaid.currency,
    total_paid: plan.totalPaid.toExactDecimalString(), financing_fee: plan.financingFee.toExactDecimalString(),
    payments: plan.payments.map((payment) => ({ date: payment.date.toISODateString(), amount: payment.amount.toExactDecimalString() })),
    changes: plan.changes.map((change) => ({ action: actionText(change), series_id: change.seriesId, source_currency: change.amount?.currency ?? null })) };
}

export async function runPlanInspection(args: readonly string[]): Promise<number> {
  const all = args[0] === "inspect-plan-summary", verbose = args[0] === "inspect-plan-candidates";
  const { datasetDirectory, requestId } = parseStateArguments(args.slice(1), !all);
  const inspection = await buildIndexes(await loadProduction(datasetDirectory), datasetDirectory);
  if (inspection.issues.some((issue) => issue.severity === "error")) { printReport(inspection, "blocking ingestion diagnostics"); return 1; }
  const data = normalizeData(inspection), ids = all ? [...data.requests.keys()].sort() : [requestId!];
  const counts: Record<string, number> = { requests_processed: 0, selected_plans: 0, no_selected_plan: 0, eligible_candidates: 0, valid_candidates: 0, rejected_candidates: 0, eligible_spending_actions: 0, action_sets: 0, selected_with_changes: 0, blocked_inputs: 0, conservative_unresolved_inputs: 0, baseline_unsafe_inputs: 0, invalid_option_diagnostics: 0 };
  const methods: Record<string, number> = {}, reasons: Record<string, number> = {}, rejections: Record<string, number> = {}, examples: Record<string, string[]> = {}, inputs: Record<string, number> = {}, optionCodes: Record<string, number> = {};
  let blocking = false;
  console.log("Buy or Wait? — internal payment-plan diagnostics; no final decisions or output rows");
  console.log("Runtime: " + process.version + "; policy=" + JSON.stringify(planPolicy) + "; hash=" + createHash("sha256").update(JSON.stringify(planPolicy)).digest("hex"));
  for (const id of ids) {
    counts.requests_processed!++;
    const reconstructed = reconstructState(data, id);
    if (reconstructed.state === null) { blocking = true; counts.blocked_inputs!++; counts.no_selected_plan!++; for (const issue of reconstructed.issues) inputs[issue.code] = (inputs[issue.code] ?? 0) + 1; if (!all) printIssues(reconstructed.issues); continue; }
    const state = reconstructed.state, recurrence = analyzeRecurrence(state), forecast = buildForecast(state, data.fx, recurrence);
    const result = selectPlans(state, forecast, recurrence, data.fx, data.paymentOptions.filter((option) => option.requestId === id));
    counts.eligible_candidates! += result.eligibleCandidates.length; counts.valid_candidates! += result.validCandidates.length;
    counts.rejected_candidates! += result.rejectedCandidates.length; counts.eligible_spending_actions! += result.search.eligibleActions; counts.action_sets! += result.search.actionSets;
    counts.invalid_option_diagnostics! += result.optionIssues.length;
    for (const issue of result.optionIssues) optionCodes[issue.code] = (optionCodes[issue.code] ?? 0) + 1;
    for (const issue of result.baseline.issues) inputs[issue.code] = (inputs[issue.code] ?? 0) + 1;
    if (result.baseline.status === "blocked") { counts.blocked_inputs!++; blocking = true; }
    if (result.baseline.status === "conservative_unresolved") counts.conservative_unresolved_inputs!++;
    if (result.baseline.status === "baseline_unsafe") counts.baseline_unsafe_inputs!++;
    if (result.selected) {
      counts.selected_plans!++; methods[result.selected.method] = (methods[result.selected.method] ?? 0) + 1;
      if (result.selected.changes.length > 0) counts.selected_with_changes!++;
    } else counts.no_selected_plan!++;
    for (const reason of result.absenceReasons) { reasons[reason] = (reasons[reason] ?? 0) + 1; const list = examples[reason] ?? []; if (list.length < 3) list.push(id); examples[reason] = list; }
    for (const candidate of result.rejectedCandidates) for (const issue of candidate.issues) rejections[issue.code] = (rejections[issue.code] ?? 0) + 1;
    if (!all) {
      console.log(JSON.stringify({ request_id: id, baseline_status: result.baseline.status, baseline_safe_to_pay: result.baselineSafeToPay?.toExactDecimalString() ?? null,
        eligible: result.eligibleCandidates.length, valid: result.validCandidates.length, rejected: result.rejectedCandidates.length, search: result.search,
        selected: result.selected ? planMetadata(result.selected) : null, absence_reasons: result.absenceReasons, ranking_trace: result.rankingTrace,
        option_issues: result.optionIssues, spending_issues: result.spendingIssues }));
      for (const candidate of result.validCandidates.filter((candidate) => verbose || candidate.plan.id === result.selected?.id)) console.log(JSON.stringify({ plan: planMetadata(candidate.plan), validation: candidate.validation.scenarios.map((scenario) => ({ pending: scenario.pending, ordering: scenario.ordering, safe: scenario.safe, minimum: scenario.minimum.toExactDecimalString(), breaches: scenario.breaches.length })) }));
      if (verbose) for (const candidate of result.rejectedCandidates) console.log(JSON.stringify({ rejected_plan: candidate.plan ? planMetadata(candidate.plan) : null, method: candidate.method, option_id: candidate.optionId, issues: candidate.issues,
        scenarios: candidate.validation?.scenarios.map((scenario) => ({ pending: scenario.pending, ordering: scenario.ordering, safe: scenario.safe, minimum: scenario.minimum.toExactDecimalString(), breaches: scenario.breaches.length })) ?? [] }));
    }
  }
  const ordered = (record: Record<string, unknown>): object => Object.fromEntries(Object.entries(record).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  console.log("PLAN_SUMMARY " + JSON.stringify({ counts, selected_methods: ordered(methods), absence_reasons: ordered(reasons), rejection_codes: ordered(rejections), input_issue_codes: ordered(inputs), option_issue_codes: ordered(optionCodes), absence_examples: ordered(examples) }));
  console.log(blocking ? "Result: BLOCKING INPUTS REPORTED; no safe plans for those requests" : "Result: SUCCESS; absence of a plan is reported explicitly");
  return blocking ? 1 : 0;
}

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
  const sensitivity = args[0] === "inspect-horizon-sensitivity";
  const all = args[0] === "inspect-capacities" || sensitivity;
  const { datasetDirectory, requestId } = parseStateArguments(args.slice(1), !all);
  const inspection = await buildIndexes(await loadProduction(datasetDirectory), datasetDirectory);
  if (inspection.issues.some((issue) => issue.severity === "error")) { printReport(inspection, "blocking ingestion diagnostics"); return 1; }
  const normalized = normalizeData(inspection);
  const ids = all ? [...normalized.requests.keys()].sort() : [requestId!];
  const issues: Issue[] = [];
  const comparisons: { id: string; production: BaselineCapacity; diagnostic: BaselineCapacity; extraDayMovements: readonly string[] }[] = [];
  const counts: Record<string, number> = {
    requests_processed: 0, valid_baseline_capacities: 0, baseline_unsafe_capacities: 0, zero_incremental_capacities: 0, no_full_payment_within_horizon: 0, baselines_already_below_minimum: 0,
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
    const recurrence = analyzeRecurrence(result.state);
    const forecast = buildForecast(result.state, normalized.fx, recurrence);
    const capacity = calculateCapacity(result.state, forecast);
    if (sensitivity) {
      const diagnosticForecast = buildDiagnosticForecast(result.state, normalized.fx, recurrence);
      const diagnostic = calculateDiagnosticCapacity(result.state, diagnosticForecast);
      comparisons.push({ id, production: capacity, diagnostic, extraDayMovements: diagnosticForecast.movements.filter((movement) => movement.date.compare(forecast.end) > 0).map((movement) => movement.id) });
      issues.push(...diagnostic.issues);
    }
    issues.push(...capacity.issues);
    if (capacity.status === "valid") counts.valid_baseline_capacities!++;
    if (capacity.status === "baseline_unsafe") counts.baseline_unsafe_capacities!++;
    if (capacity.incrementalCapacity.status === "zero_incremental_capacity") counts.zero_incremental_capacities!++;
    if (capacity.fullPaymentFeasibility.status === "no_full_payment_within_horizon") counts.no_full_payment_within_horizon!++;
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
        incremental_capacity_status: capacity.incrementalCapacity.status, full_payment_status: capacity.fullPaymentFeasibility.status,
        earliest_date_reason: capacity.fullPaymentFeasibility.reason, baseline_breached: capacity.baselineBreached,
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
  if (sensitivity) printHorizonComparison(comparisons);
  console.log("Missing earliest dates include blocked/unresolved requests; they do not prove impossibility. Order sensitivity compares daily checkpoint minima.");
  const unique = new Map(issues.map((issue) => [JSON.stringify(issue), issue]));
  const ordered = sortIssues([...unique.values()]);
  printIssues(ordered);
  return ordered.some((issue) => issue.severity === "error") ? 1 : 0;
}

function printHorizonComparison(rows: readonly { id: string; production: BaselineCapacity; diagnostic: BaselineCapacity; extraDayMovements: readonly string[] }[]): void {
  const category = (result: BaselineCapacity): string => result.status !== "valid" ? result.status : result.fullPaymentFeasibility.status === "no_full_payment_within_horizon" ? "no_full_payment_within_horizon" : "valid";
  const differentAmount = (a: Money | null, b: Money | null): boolean => a === null || b === null ? a !== b : !a.equals(b);
  const altered = rows.filter((row) => differentAmount(row.production.maximumImmediatePayment, row.diagnostic.maximumImmediatePayment));
  const dates = rows.filter((row) => (row.production.earliestFullPaymentDate?.toISODateString() ?? null) !== (row.diagnostic.earliestFullPaymentDate?.toISODateString() ?? null));
  const switches = rows.filter((row) => category(row.production) !== category(row.diagnostic));
  const transitions: Record<string, number> = {}, diagnosticCounts: Record<string, number> = {};
  const byCurrency = new Map<string, Money[]>();
  for (const row of rows) {
    const key = category(row.production) + " -> " + category(row.diagnostic);
    transitions[key] = (transitions[key] ?? 0) + 1;
    diagnosticCounts[row.diagnostic.status] = (diagnosticCounts[row.diagnostic.status] ?? 0) + 1;
    if (row.production.maximumImmediatePayment !== null && row.diagnostic.maximumImmediatePayment !== null) {
      const delta = row.diagnostic.maximumImmediatePayment.subtract(row.production.maximumImmediatePayment);
      const values = byCurrency.get(delta.currency) ?? []; values.push(delta); byCurrency.set(delta.currency, values);
    }
  }
  const median = (values: readonly Money[]): string | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a.compare(b)), middle = Math.floor(sorted.length / 2);
    return (sorted.length % 2 === 1 ? sorted[middle]! : sorted[middle - 1]!.add(sorted[middle]!).multiplyByRate("0.5")).toExactDecimalString();
  };
  console.log("HORIZON_COMPARISON " + JSON.stringify({ production_policy: "inclusive_90_dates_v1", diagnostic_policy: "through_day_90_sensitivity_only", compared: rows.length,
    capacity_result_changes: altered.length, comparable_exact_capacity_changes: altered.filter((row) => row.production.maximumImmediatePayment !== null && row.diagnostic.maximumImmediatePayment !== null).length,
    earliest_date_changes: dates.length, category_switches: switches.length, diagnostic_baseline_counts: diagnosticCounts,
    diagnostic_earliest_found: rows.filter((row) => row.diagnostic.earliestFullPaymentDate !== null).length,
    diagnostic_no_full_payment: rows.filter((row) => row.diagnostic.fullPaymentFeasibility.status === "no_full_payment_within_horizon").length,
    transitions: Object.fromEntries(Object.entries(transitions).sort()), delta_definition: "diagnostic_91_minus_production_90; currencies never combined; null capacities excluded from monetary metrics",
    deltas_by_currency: Object.fromEntries([...byCurrency].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([currency, values]) => {
      const zero = Money.fromDecimalString("0", values[0]!.currency), changed = values.filter((value) => !value.isZero()), absolute = values.map((value) => value.compare(zero) < 0 ? value.negate() : value);
      return [currency, { comparable: values.length, changed: changed.length, maximum_absolute_delta: absolute.reduce((a, b) => a.maximum(b), zero).toExactDecimalString(), median_signed_delta: median(values), median_absolute_delta: median(absolute), median_changed_signed_delta: median(changed) }];
    })),
    affected_examples: rows.filter((row) => altered.includes(row) || dates.includes(row) || switches.includes(row)).sort((a, b) => (switches.includes(a) ? 0 : 1) - (switches.includes(b) ? 0 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, 8).map((row) => ({ request_id: row.id,
      reasons: [differentAmount(row.production.maximumImmediatePayment, row.diagnostic.maximumImmediatePayment) ? "CAPACITY_CHANGED" : null, (row.production.earliestFullPaymentDate?.toISODateString() ?? null) !== (row.diagnostic.earliestFullPaymentDate?.toISODateString() ?? null) ? "EARLIEST_DATE_CHANGED" : null, category(row.production) !== category(row.diagnostic) ? "RESULT_CATEGORY_CHANGED" : null].filter((value) => value !== null),
      category_90: category(row.production), category_91: category(row.diagnostic), capacity_90: row.production.maximumImmediatePayment?.toExactDecimalString() ?? null,
      capacity_91: row.diagnostic.maximumImmediatePayment?.toExactDecimalString() ?? null, earliest_reason_90: row.production.fullPaymentFeasibility.reason, earliest_reason_91: row.diagnostic.fullPaymentFeasibility.reason, extra_day_movement_ids: row.extraDayMovements })) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    process.exitCode = ["inspect-plans", "inspect-plan-candidates", "inspect-plan-summary"].includes(args[0] ?? "") ? await runPlanInspection(args) : ["inspect-forecast", "inspect-capacity", "inspect-capacities", "inspect-horizon-sensitivity"].includes(args[0] ?? "") ? await runForecastInspection(args) : args[0] === "inspect-recurrence" ? await runRecurrenceInspection(args.slice(1)) : args[0] === "inspect-state" || args[0] === "inspect-states" ?
      await runStateInspection(args) : await runInspection(args);
  } catch {
    console.error("CLI_ERROR: invalid arguments or unexpected inspection failure. Use inspect, inspect-state, inspect-states, inspect-recurrence, inspect-forecast, inspect-capacity, inspect-capacities, inspect-plans, inspect-plan-candidates, or inspect-plan-summary with --dataset <directory> and --request <id> where required; ambiguous paths require an absolute path.");
    process.exitCode = 1;
  }
}
