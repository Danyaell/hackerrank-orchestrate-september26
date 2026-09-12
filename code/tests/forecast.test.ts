import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Money } from "../src/core/money.js";
import { forecastPolicy } from "../src/config.js";
import { loadProduction } from "../src/data/load.js";
import { buildIndexes } from "../src/data/indexes.js";
import { normalizeData } from "../src/data/normalize.js";
import { reconstructState } from "../src/finance/state.js";
import { analyzeRecurrence } from "../src/finance/recurrence.js";
import { buildForecast, buildDiagnosticForecast } from "../src/finance/forecast.js";
import { simulate } from "../src/finance/simulate.js";
import { calculateCapacity, calculateDiagnosticCapacity } from "../src/finance/capacity.js";
import { fixture, minimalRows } from "./fixtures.js";
import type { FixtureRows } from "./fixtures.js";

const money = (amount: string) => Money.fromDecimalString(amount, "INR");
const text = (amount: Money | null): string | null => amount?.toExactDecimalString() ?? null;
const event = (id: string, fields: Record<string, string> = {}): Record<string, string> => ({ ...minimalRows().financial_events[0]!, event_id: id, ...fields });
const future = (id: string, amount = "200", value = "2025-08-05", fields: Record<string, string> = {}) => event(id, { amount, event_date: "2025-08-01", settlement_date: value, status: "scheduled", ...fields });
const history = (dates: readonly string[], fields: Record<string, string> = {}) => dates.map((value, index) => event("past-" + index, { event_date: value, settlement_date: value, ...fields }));
const monthly = ["2025-05-05", "2025-06-05", "2025-07-05"];
async function prepare(context: TestContext, events: Record<string, string>[] = [], adjust?: (rows: FixtureRows) => void) {
  const rows = minimalRows(); rows.financial_events = events; rows.messages = []; rows.images = []; adjust?.(rows);
  const input = await fixture(rows, false); context.after(input.cleanup);
  const inspection = await buildIndexes(await loadProduction(input.directory), input.directory);
  assert.deepEqual(inspection.issues.filter((issue) => issue.severity === "error"), []);
  const data = normalizeData(inspection);
  const result = reconstructState(data, "purchase-alpha"); assert.ok(result.state, JSON.stringify(result.issues));
  const state = result.state, forecast = buildForecast(state, data.fx);
  return { state, forecast, data, input, capacity: calculateCapacity(state, forecast) };
}

test("simple confirmed future debit reduces exact capacity", async (context) => {
  const { forecast, capacity } = await prepare(context, [future("bill")]);
  assert.equal(forecast.movements.length, 1); assert.equal(forecast.movements[0]!.kind, "confirmed_future_commitment");
  assert.equal(text(capacity.maximumImmediatePayment), "700"); assert.equal(capacity.status, "valid");
});
test("simple confirmed future credit is available on its dated cash phase", async (context) => {
  const { state, forecast } = await prepare(context, [future("salary", "200", "2025-08-05", { direction: "credit", event_type: "income", category: "salary", description: "Payroll" })]);
  const trace = simulate(state, forecast, "excludes_holds", "debits_before_credits");
  assert.equal(text(trace.days[4]!.spendableBalance), "1200"); assert.equal(text(trace.days[3]!.spendableBalance), "1000");
});
test("historical settled movements are never replayed against snapshot", async (context) => {
  const { forecast, capacity } = await prepare(context, history(["2025-07-01"], { event_type: "investment_purchase", amount: "900" }));
  assert.equal(forecast.movements.length, 0); assert.equal(text(capacity.maximumImmediatePayment), "900");
  assert.ok(capacity.baselineTraces.every((trace) => text(trace.minimumBalance) === "1000"));
});
test("supported recurring fixed expense expands with retained provenance", async (context) => {
  const { forecast } = await prepare(context, history(monthly));
  assert.deepEqual(forecast.movements.map((movement) => movement.date.toISODateString()), ["2025-08-05", "2025-09-05", "2025-10-05"]);
  assert.ok(forecast.movements.every((movement) => movement.kind === "generated_recurring_expense" && text(movement.amount) === "-50" && movement.provenance.length === 3));
});
test("supported continuous income expands using strict source estimate", async (context) => {
  const { forecast } = await prepare(context, history(["2025-07-02", "2025-07-09", "2025-07-16", "2025-07-23", "2025-07-30"], { direction: "credit", event_type: "income", category: "salary", description: "Payroll", amount: "100" }));
  assert.equal(forecast.movements[0]!.date.toISODateString(), "2025-08-06");
  assert.ok(forecast.movements.every((movement) => movement.kind === "generated_recurring_income" && text(movement.amount) === "100"));
});
test("inactive income is excluded without inventing continuity", async (context) => {
  const { forecast, capacity } = await prepare(context, history(["2025-01-01", "2025-01-08", "2025-01-15", "2025-01-22", "2025-01-29"], { direction: "credit", event_type: "income", category: "salary", description: "Payroll" }));
  assert.equal(forecast.movements.length, 0); assert.equal(capacity.status, "valid");
});
test("ambiguous and inactive expenses are surfaced, never silently omitted as safe", async (context) => {
  for (const dates of [["2025-06-01", "2025-06-10", "2025-07-29"], ["2025-01-01", "2025-01-08", "2025-01-15"]]) {
    const { forecast, capacity } = await prepare(context, history(dates));
    assert.equal(capacity.status, "conservative_unresolved"); assert.equal(capacity.maximumImmediatePayment, null);
    assert.deepEqual(capacity.fullPaymentFeasibility, { status: "not_calculable", date: null, reason: "conservative_unresolved" });
    assert.ok(forecast.issues.some((issue) => issue.code === "FORECAST_UNCERTAIN_EXPENSE_SERIES")); assert.ok(forecast.unresolvedObligations[0]!.provenance.length > 0);
  }
});
test("missing debit amount blocks capacity and never creates zero movement", async (context) => {
  const { forecast, capacity } = await prepare(context, [future("unknown", "")]);
  assert.equal(forecast.movements.length, 0); assert.equal(forecast.unresolvedObligations[0]!.knownAmount, null);
  assert.deepEqual(capacity.fullPaymentFeasibility, { status: "not_calculable", date: null, reason: "blocked" });
  assert.equal(capacity.status, "blocked"); assert.equal(capacity.maximumImmediatePayment, null); assert.equal(capacity.earliestFullPaymentDate, null);
});
test("foreign projected recurrence uses each dated directed rate exactly", async (context) => {
  const dates = [...monthly, "2025-08-05", "2025-09-05", "2025-10-05"];
  const { forecast } = await prepare(context, history(monthly, { currency: "USD", amount: "0.1" }), (rows) => {
    rows.exchange_rates = dates.map((value, index) => ({ rate_date: value, from_currency: "USD", to_currency: "INR", rate: index < 3 ? "80" : "80.3" }));
  });
  assert.equal(text(forecast.movements[0]!.amount), "-8.03"); assert.equal(text(forecast.movements[0]!.original), "0.1");
  assert.equal(forecast.movements[0]!.fx!.rateDate!.toISODateString(), "2025-08-05"); assert.ok(forecast.movements[0]!.fx!.rateSource);
});
test("missing future FX never falls back to historical rate or zero", async (context) => {
  const { forecast, capacity } = await prepare(context, history(monthly, { currency: "USD", amount: "1" }), (rows) => {
    rows.exchange_rates = monthly.map((value) => ({ rate_date: value, from_currency: "USD", to_currency: "INR", rate: "80" }));
  });
  assert.equal(forecast.movements.length, 0); assert.equal(capacity.status, "blocked");
  assert.equal(forecast.issues.filter((issue) => issue.code === "FORECAST_PROJECTED_FX_MISSING_RATE").length, 3);
});
test("unique supplied/generated signature overlap is counted once even when supplied amount changes", async (context) => {
  const { forecast } = await prepare(context, [...history(monthly), future("supplied", "65")]);
  const sameDay = forecast.movements.filter((movement) => movement.date.toISODateString() === "2025-08-05");
  assert.equal(sameDay.length, 1); assert.equal(text(sameDay[0]!.amount), "-65");
  assert.equal(forecast.suppressedMovements.length, 1); assert.equal(forecast.suppressedMovements[0]!.deduplication.matchedMovementId, sameDay[0]!.id);
});
test("distinct same-day obligations are retained despite equal category, amount and currency", async (context) => {
  const { forecast } = await prepare(context, [...history(monthly), future("distinct", "50", "2025-08-05", { description: "Different rent obligation" })]);
  assert.equal(forecast.movements.filter((movement) => movement.date.toISODateString() === "2025-08-05").length, 2);
  assert.equal(forecast.suppressedMovements.length, 0);
});
test("a matching pending monthly obligation is reserved once, not added as recurrence cash", async (context) => {
  const { forecast, capacity } = await prepare(context, [...history(monthly), future("pending-rent", "50", "2025-08-05", { status: "pending" })]);
  assert.equal(forecast.suppressedMovements.length, 1);
  assert.equal(forecast.movements.filter((movement) => movement.kind === "generated_recurring_expense").length, 2);
  assert.equal(text(capacity.maximumImmediatePayment), "750");
});
test("category stream similarity alone cannot suppress a distinct supplied merchant", async (context) => {
  const past = history(["2025-07-15", "2025-07-22", "2025-07-29"], { category: "groceries", flexibility: "reducible" });
  past.forEach((row, index) => { row.description = "Merchant " + index; row.amount = String(10 + index); });
  const { forecast } = await prepare(context, [...past, future("separate-store", "12", "2025-08-05", { description: "Different store", category: "groceries", flexibility: "reducible" })]);
  assert.equal(forecast.suppressedMovements.length, 0);
  assert.equal(forecast.movements.filter((movement) => movement.date.toISODateString() === "2025-08-05").length, 2);
});
test("multiple matching supplied obligations retain identity and expose ambiguous overlap", async (context) => {
  const { forecast, capacity } = await prepare(context, [...history(monthly), future("rent-one", "50"), future("rent-two", "50")]);
  assert.equal(forecast.movements.filter((movement) => movement.date.toISODateString() === "2025-08-05").length, 3);
  assert.equal(forecast.suppressedMovements.length, 0);
  assert.ok(forecast.issues.some((issue) => issue.code === "FORECAST_AMBIGUOUS_OVERLAP"));
  assert.equal(capacity.status, "conservative_unresolved");
});
test("calendar month-end expansion preserves its anchor without drift", async (context) => {
  const { forecast } = await prepare(context, history(["2025-05-31", "2025-06-30", "2025-07-31"]));
  assert.deepEqual(forecast.movements.map((movement) => movement.date.toISODateString()), ["2025-08-31", "2025-09-30"]);
});
test("failed debt remains an uncertain reserve while a confirmed retry counts only once", async (context) => {
  const failed = future("debt-failed", "200", "2025-07-31", { event_type: "debt_payment", category: "debt_repayment", status: "failed" });
  const missing = await prepare(context, [failed]);
  assert.equal(missing.capacity.status, "conservative_unresolved");
  assert.equal(missing.forecast.movements[0]!.operation, "reserve_open");
  assert.equal(text(missing.capacity.baselineTraces[0]!.minimumBalance), "800");
  const retry = await prepare(context, [failed, future("retry", "200", "2025-08-05", { event_type: "debt_payment", category: "debt_repayment", linked_event_id: "debt-failed" })]);
  assert.equal(retry.forecast.movements.length, 1); assert.equal(text(retry.capacity.maximumImmediatePayment), "700");
});
test("past pending settlement dates keep the exposure reserved without inventing a new date", async (context) => {
  const { forecast, capacity } = await prepare(context, [future("past-pending", "200", "2025-07-31", { status: "pending" })]);
  assert.equal(forecast.movements.length, 1);
  assert.ok(capacity.baselineTraces.every((trace) => text(trace.days.at(-1)!.heldAmount) === "200"));
});
test("pending debit exposure under both snapshots is charged exactly once when settled", async (context) => {
  const { state, forecast, capacity } = await prepare(context, [future("pending", "200", "2025-08-03", { status: "pending" })]);
  for (const [scenario, expected] of [["includes_holds", "1000"], ["excludes_holds", "800"]] as const) {
    const trace = simulate(state, forecast, scenario, "debits_before_credits");
    assert.equal(text(trace.days[0]!.spendableBalance), expected); assert.equal(text(trace.days[2]!.spendableBalance), expected);
    assert.equal(text(trace.days[2]!.heldAmount), "0"); assert.deepEqual([...trace.pendingAccounting.values()], [{ opened: true, settled: true }]); assert.equal(trace.issues.length, 0);
  }
  assert.equal(text(capacity.maximumImmediatePayment), "700"); assert.equal(capacity.pendingSensitive, true); assert.ok(capacity.limitingScenario.startsWith("excludes_holds"));
});
test("pending credit and pending refund never increase funds", async (context) => {
  const { forecast, capacity } = await prepare(context, [future("claim", "500", "2025-08-02", { status: "pending", direction: "credit", event_type: "income" }),
    future("refund", "500", "2025-08-02", { status: "pending", direction: "credit", event_type: "refund" })]);
  assert.equal(forecast.movements.length, 0); assert.deepEqual(forecast.excludedCreditEventIds, ["claim", "refund"]);
  assert.equal(text(capacity.maximumImmediatePayment), "900");
});
test("explicit matching pending settlement does not add a second supplied debit, while identity ambiguity stays visible", async (context) => {
  const { state, forecast, capacity } = await prepare(context, [future("hold", "200", "2025-08-03", { status: "pending" }), future("settled", "200", "2025-08-03", { status: "settled", linked_event_id: "hold" })]);
  assert.equal(forecast.movements.length, 2); assert.equal(forecast.suppressedMovements.length, 1);
  const trace = simulate(state, forecast, "excludes_holds", "debits_before_credits"); assert.equal(text(trace.minimumBalance), "800");
  assert.equal(capacity.status, "conservative_unresolved");
});
test("debit-first detects an intraday breach hidden by daily closing balance", async (context) => {
  const { state, forecast, capacity } = await prepare(context, [future("debit", "150"), future("credit", "200", "2025-08-05", { direction: "credit", event_type: "income" })], (rows) => { rows.financial_profiles[0]!.current_available_balance = "200"; });
  const debitFirst = simulate(state, forecast, "excludes_holds", "debits_before_credits"), creditFirst = simulate(state, forecast, "excludes_holds", "credits_before_debits");
  assert.equal(text(debitFirst.days[4]!.spendableBalance), "250"); assert.equal(text(debitFirst.days[4]!.minimumBalance), "50");
  assert.equal(creditFirst.breaches.length, 0); assert.ok(debitFirst.breaches.some((point) => point.movement?.sourceEventIds.includes("debit")));
  assert.equal(capacity.status, "baseline_unsafe"); assert.equal(capacity.maximumImmediatePayment, null); assert.equal(capacity.sameDaySensitive, true);
});
test("baseline already below minimum cannot be repaired by a future purchase date", async (context) => {
  const { capacity } = await prepare(context, [], (rows) => { rows.financial_profiles[0]!.current_available_balance = "99"; });
  assert.equal(capacity.status, "baseline_unsafe"); assert.equal(text(capacity.margin), "-1"); assert.equal(capacity.earliestFullPaymentDate, null);
  assert.equal(capacity.fullPaymentFeasibility.reason, "baseline_unsafe"); assert.equal(capacity.incrementalCapacity.status, "not_calculable");
});
test("exact immediate capacity passes at the boundary and fails by one small decimal increment", async (context) => {
  const { state, forecast, capacity } = await prepare(context, [future("bill", "0.2")], (rows) => { rows.financial_profiles[0]!.current_available_balance = "100.5"; });
  assert.equal(text(capacity.maximumImmediatePayment), "0.3");
  const probe = (amount: string) => simulate(state, forecast, "excludes_holds", "debits_before_credits", [{ id: "probe", date: state.request.date, amount: money(amount).negate(), source: state.request.source }]);
  assert.equal(probe("0.3").breaches.length, 0); assert.ok(probe("0.300001").breaches.length > 0);
});
test("capacity is uncapped when the requested amount is lower; earliest full payment is today", async (context) => {
  const { capacity } = await prepare(context, [], (rows) => { rows.requests[0]!.requested_amount = "20"; });
  assert.equal(text(capacity.maximumImmediatePayment), "900"); assert.equal(capacity.earliestFullPaymentDate!.toISODateString(), "2025-08-01");
});
test("requested amount above all horizon capacity has no full-payment date", async (context) => {
  const { capacity } = await prepare(context, [], (rows) => { rows.requests[0]!.requested_amount = "1000"; });
  assert.equal(text(capacity.maximumImmediatePayment), "900"); assert.equal(capacity.earliestFullPaymentDate, null);
  assert.equal(capacity.status, "valid"); assert.equal(capacity.fullPaymentFeasibility.reason, "no_full_payment_within_horizon");
});
test("later full payment cannot rely on that day's credit arriving before its debit phase", async (context) => {
  const { capacity } = await prepare(context, [future("salary", "200", "2025-08-02", { direction: "credit", event_type: "income" })], (rows) => { rows.financial_profiles[0]!.current_available_balance = "100"; });
  assert.equal(text(capacity.maximumImmediatePayment), "0"); assert.equal(capacity.earliestFullPaymentDate!.toISODateString(), "2025-08-03");
  assert.equal(capacity.incrementalCapacity.status, "zero_incremental_capacity"); assert.equal(capacity.status, "valid");
});
test("resolved zero incremental capacity differs from unavailable data and preserves null-date reason", async (context) => {
  const { capacity } = await prepare(context, [], (rows) => { rows.financial_profiles[0]!.current_available_balance = "100"; });
  assert.equal(capacity.status, "valid"); assert.equal(capacity.baselineBreached, false);
  assert.equal(capacity.incrementalCapacity.status, "zero_incremental_capacity"); assert.equal(text(capacity.incrementalCapacity.amount), "0");
  assert.deepEqual(capacity.fullPaymentFeasibility, { status: "no_full_payment_within_horizon", date: null, reason: "no_full_payment_within_horizon" });
});
test("production commands cannot select a sensitivity horizon flag", async (context) => {
  const { input } = await prepare(context);
  const main = fileURLToPath(new URL("../src/main.js", import.meta.url));
  for (const command of ["inspect-capacity", "inspect-capacities"]) {
    const cli = spawnSync(process.execPath, [main, command, "--dataset", input.directory, ...(command === "inspect-capacity" ? ["--request", "purchase-alpha"] : []), "--horizon", "through_day_90_sensitivity_only"], { encoding: "utf8" });
    assert.equal(cli.status, 1); assert.ok(cli.stderr.includes("CLI_ERROR"));
  }
  const defaultCli = spawnSync(process.execPath, [main, "inspect-capacities", "--dataset", input.directory], { encoding: "utf8" });
  assert.equal(defaultCli.status, 0); assert.ok(defaultCli.stdout.includes("through 2025-10-29 inclusive; policy=inclusive_90_dates_v1"));
  assert.ok(!defaultCli.stdout.includes("through_day_90_sensitivity_only"));
  const sensitivityCli = spawnSync(process.execPath, [main, "inspect-horizon-sensitivity", "--dataset", input.directory], { encoding: "utf8" });
  assert.equal(sensitivityCli.status, 0); assert.ok(sensitivityCli.stdout.includes("HORIZON_COMPARISON"));
});
test("earliest full payment is independent of preferences and completion deadline", async (context) => {
  const alter = (rows: FixtureRows) => { rows.financial_profiles[0]!.current_available_balance = "100"; rows.financial_profiles[0]!.payment_methods_user_will_consider = "installments"; rows.financial_profiles[0]!.max_installment_months = "3"; rows.requests[0]!.desired_completion_date = "2025-08-01"; };
  const { capacity } = await prepare(context, [future("salary", "200", "2025-08-02", { direction: "credit", event_type: "income" })], alter);
  assert.equal(capacity.earliestFullPaymentDate!.toISODateString(), "2025-08-03");
});
test("default horizon includes offsets zero through 89 and excludes day 90", async (context) => {
  const { state, data, forecast, capacity } = await prepare(context, [future("today", "1", "2025-08-01"), future("end", "2", "2025-10-29"), future("outside", "3", "2025-10-30")]);
  assert.equal(forecastPolicy.horizonDays, 89); assert.equal(forecast.policyVersion, "inclusive_90_dates_v1");
  assert.equal(forecast.end.toISODateString(), "2025-10-29"); assert.equal(forecast.movements.length, 2);
  assert.equal(simulate(state, forecast, "excludes_holds", "debits_before_credits").days.length, 90);
  assert.equal(text(capacity.maximumImmediatePayment), "897");
  const sensitivity = buildDiagnosticForecast(state, data.fx);
  assert.equal(sensitivity.policyVersion, "through_day_90_sensitivity_only");
  assert.equal(sensitivity.movements.length, 3); assert.equal(calculateDiagnosticCapacity(state, sensitivity).baselineTraces[0]!.days.length, 91);
  assert.equal(text(calculateDiagnosticCapacity(state, sensitivity).maximumImmediatePayment), "894");
  const rejected = calculateCapacity(state, sensitivity);
  assert.equal(rejected.status, "blocked"); assert.equal(rejected.maximumImmediatePayment, null);
  assert.ok(rejected.issues.some((issue) => issue.code === "CAPACITY_NON_PRODUCTION_HORIZON"));
  const short = buildDiagnosticForecast(state, data.fx, analyzeRecurrence(state), 0); assert.notEqual(short.policyHash, forecast.policyHash); assert.equal(short.movements.length, 1);
});
test("full payment on final horizon date is found; a final-day credit cannot support same-day early payment", async (context) => {
  const { capacity } = await prepare(context, [future("income", "100", "2025-10-28", { direction: "credit", event_type: "income" })], (rows) => { rows.financial_profiles[0]!.current_available_balance = "100"; });
  assert.equal(capacity.earliestFullPaymentDate!.toISODateString(), "2025-10-29");
  const { capacity: tooLate, state, data } = await prepare(context, [future("income", "100", "2025-10-29", { direction: "credit", event_type: "income" })], (rows) => { rows.financial_profiles[0]!.current_available_balance = "100"; });
  assert.equal(tooLate.earliestFullPaymentDate, null);
  assert.equal(tooLate.fullPaymentFeasibility.reason, "no_full_payment_within_horizon");
  assert.equal(calculateDiagnosticCapacity(state, buildDiagnosticForecast(state, data.fx)).earliestFullPaymentDate!.toISODateString(), "2025-10-30");
});
test("suffix pruning agrees with exhaustive injected simulation at every candidate date", async (context) => {
  for (const amount of ["50", "100", "300"]) {
    const { state, data } = await prepare(context, [future("income", "200", "2025-08-02", { direction: "credit", event_type: "income", category: "salary" }), future("bill", "50", "2025-08-04")], (rows) => {
      rows.financial_profiles[0]!.current_available_balance = "150"; rows.requests[0]!.requested_amount = amount;
    });
    const forecast = buildDiagnosticForecast(state, data.fx, analyzeRecurrence(state), 7), result = calculateDiagnosticCapacity(state, forecast);
    let expected: string | null = null;
    for (let day = 0; day <= 7; day++) {
      const value = state.request.date.addDays(day), injection = { id: "oracle", date: value, amount: state.request.amount.negate(), source: state.request.source };
      if (result.baselineTraces.every((trace) => simulate(state, forecast, trace.pendingScenario, trace.sameDayOrder, [injection]).breaches.length === 0)) { expected = value.toISODateString(); break; }
    }
    assert.equal(result.earliestFullPaymentDate?.toISODateString() ?? null, expected);
  }
});
test("known pending snapshot policy uses its explicit scenario while unknown uses both", async (context) => {
  const { state, forecast } = await prepare(context, [future("hold", "200", "2025-08-03", { status: "pending" })]);
  const included = calculateCapacity({ ...state, pendingBalancePolicy: "includes_holds" }, forecast);
  const excluded = calculateCapacity({ ...state, pendingBalancePolicy: "excludes_holds" }, forecast);
  assert.equal(included.baselineTraces.length, 2); assert.equal(excluded.baselineTraces.length, 2);
  assert.equal(text(included.maximumImmediatePayment), "900"); assert.equal(text(excluded.maximumImmediatePayment), "700");
});
test("diagnostic injections with foreign currency or dates outside the horizon fail explicitly", async (context) => {
  const { state, forecast } = await prepare(context);
  const invalid = simulate(state, forecast, "excludes_holds", "debits_before_credits", [
    { id: "wrong-currency", date: state.request.date, amount: Money.fromDecimalString("-1", "USD"), source: state.request.source },
    { id: "wrong-date", date: forecast.end.addDays(1), amount: money("-1"), source: state.request.source },
  ]);
  assert.deepEqual(invalid.issues.map((issue) => issue.code).sort(), ["SIM_CURRENCY_MISMATCH", "SIM_DATE_OUTSIDE_HORIZON"]);
});
test("trace order is deterministic within equivalent phases", async (context) => {
  const { state, forecast } = await prepare(context, [future("z", "10"), future("a", "20")]);
  const first = simulate(state, forecast, "excludes_holds", "debits_before_credits");
  assert.deepEqual(simulate(state, { ...forecast, movements: [...forecast.movements].reverse() }, "excludes_holds", "debits_before_credits"), first);
});
test("variable expense uses the strict maximum, never the lower reference median", async (context) => {
  const events = history(monthly); ["10", "100", "20"].forEach((amount, index) => { events[index]!.amount = amount; });
  const { forecast } = await prepare(context, events);
  assert.ok(forecast.movements.every((movement) => text(movement.original) === "100"));
});
test("scheduled speculative credits remain unavailable until supplied settled", async (context) => {
  const { forecast } = await prepare(context, [future("bonus", "500", "2025-08-02", { direction: "credit", event_type: "income", description: "Bonus" }), future("settled-bonus", "10", "2025-08-03", { direction: "credit", event_type: "income", status: "settled", description: "Bonus" })]);
  assert.deepEqual(forecast.excludedCreditEventIds, ["bonus"]); assert.equal(forecast.movements.length, 1); assert.equal(text(forecast.movements[0]!.amount), "10");
});
test("duplicate and mismatched hold settlement inputs produce blocking simulation diagnostics", async (context) => {
  const { state, forecast } = await prepare(context, [future("pending", "200", "2025-08-03", { status: "pending" })]);
  const settle = forecast.movements.find((movement) => movement.operation === "hold_settle")!;
  const duplicate = simulate(state, { ...forecast, movements: [...forecast.movements, settle] }, "excludes_holds", "debits_before_credits"); assert.ok(duplicate.issues.some((issue) => issue.code === "SIM_DUPLICATE_MOVEMENT"));
  const wrong = simulate(state, { ...forecast, movements: forecast.movements.map((movement) => movement === settle ? { ...movement, amount: money("-199") } : movement) }, "excludes_holds", "debits_before_credits"); assert.ok(wrong.issues.some((issue) => issue.code === "SIM_INVALID_HOLD_SETTLEMENT"));
});
test("forecast and capacity CLI paths retain actual filesystem sample-output isolation", async (context) => {
  const { state, data, input } = await prepare(context);
  await mkdir(input.directory + "/sample_requests.csv"); await mkdir(input.directory + "/output.csv");
  const opened: string[] = [];
  await loadProduction(input.directory, async (path) => { opened.push(basename(path)); return readFile(path); });
  assert.equal(opened.length, 7); assert.ok(!opened.includes("sample_requests.csv") && !opened.includes("output.csv"));
  assert.equal(calculateCapacity(state, buildForecast(state, data.fx)).status, "valid");
  const main = fileURLToPath(new URL("../src/main.js", import.meta.url));
  for (const command of ["inspect-forecast", "inspect-capacity", "inspect-capacities"]) {
    const args = [main, command, "--dataset", input.directory, ...(command === "inspect-capacities" ? [] : ["--request", "purchase-alpha"])];
    const cli = spawnSync(process.execPath, args, { cwd: dirname(input.directory), encoding: "utf8" }); assert.equal(cli.status, 0, cli.stdout + cli.stderr); assert.ok(!cli.stdout.includes("Private fixture"));
    if (command !== "inspect-capacities") {
      const unknown = spawnSync(process.execPath, [main, command, "--dataset", input.directory, "--request", "unknown-purchase"], { encoding: "utf8" });
      assert.equal(unknown.status, 1); assert.ok(unknown.stdout.includes("UNKNOWN_REQUEST"));
    }
  }
});
test("missing debit amount causes a nonzero capacity CLI exit and no claimed safe amount", async (context) => {
  const { input } = await prepare(context, [future("missing", "")]);
  const main = fileURLToPath(new URL("../src/main.js", import.meta.url));
  const cli = spawnSync(process.execPath, [main, "inspect-capacity", "--dataset", input.directory, "--request", "purchase-alpha"], { encoding: "utf8" });
  assert.equal(cli.status, 1); assert.ok(cli.stdout.includes("FORECAST_UNRESOLVED_DEBIT_AMOUNT"));
  assert.ok(cli.stdout.includes('"maximum_immediate_payment":null'));
});
