import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatasetArgument, parseStateArguments, productionFiles, sortIssues } from "./config.js";
import { loadProduction } from "./data/load.js";
import { buildIndexes } from "./data/indexes.js";
import type { InspectionResult, Issue, TableName } from "./domain.js";
import type { FinancialState, StateResult } from "./domain.js";
import { normalizeData } from "./data/normalize.js";
import { reconstructState } from "./finance/state.js";

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    process.exitCode = args[0] === "inspect-state" || args[0] === "inspect-states" ?
      await runStateInspection(args) : await runInspection(args);
  } catch {
    console.error("CLI_ERROR: invalid arguments or unexpected inspection failure. Use inspect --dataset <directory>, inspect-state --dataset <directory> --request <id>, or inspect-states --dataset <directory>; ambiguous paths require an absolute path.");
    process.exitCode = 1;
  }
}
