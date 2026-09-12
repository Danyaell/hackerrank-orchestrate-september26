import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DateOnly } from "../src/core/dates.js";
import { Money } from "../src/core/money.js";
import { recurrencePolicy } from "../src/config.js";
import { analyzeRecurrence, detectSeries, detectSchedule, eligibleHistorical, estimateAmount, ExactRatio, groupObservations, normalizeDescription, observationMatches, policyHash } from "../src/finance/recurrence.js";
import { backtestPolicy, candidatePolicies, rollingOrigins, rollingPredictions, selectPolicy, renderRecurrenceReport, selectionObjective } from "../evaluation/backtest.js";
import { loadProduction } from "../src/data/load.js";
import { buildIndexes } from "../src/data/indexes.js";
import { normalizeData } from "../src/data/normalize.js";
import { reconstructState } from "../src/finance/state.js";
import type { RecurrenceObservation, RecurrencePolicy } from "../src/domain.js";
import { fixture, minimalRows } from "./fixtures.js";
import type { FixtureRows } from "./fixtures.js";

const date = DateOnly.parse;
const exactAmount = (amount: ReturnType<typeof estimateAmount>): string => ExactRatio.fromAmount(amount).toFractionString();
function observations(dates: readonly string[], amounts: readonly string[] = ["100"], fields: Partial<RecurrenceObservation> = {}): RecurrenceObservation[] {
  return dates.map((value, index) => ({ eventId: "fact-" + index, userId: "person-alpha", direction: "debit", eventType: "expense", category: "rent",
    description: "rent", flexibility: "fixed", amount: Money.fromDecimalString(amounts[index % amounts.length]!, "INR"), date: date(value),
    source: { filename: "financial_events.csv", row: index + 1, recordId: "fact-" + index }, ...fields }));
}
const weekly = ["2025-07-01", "2025-07-08", "2025-07-15", "2025-07-22", "2025-07-29"];
async function prepare(context: TestContext, events: Record<string, string>[], adjust?: (rows: FixtureRows) => void) {
  const rows = minimalRows(); rows.financial_events = events; rows.messages = []; rows.images = []; adjust?.(rows);
  const input = await fixture(rows, false); context.after(input.cleanup);
  const inspection = await buildIndexes(await loadProduction(input.directory), input.directory);
  const data = normalizeData(inspection); const result = reconstructState(data, "purchase-alpha");
  assert.ok(result.state, JSON.stringify(result.issues));
  return { state: result.state, input, data };
}
const event = (id: string, fields: Record<string, string> = {}): Record<string, string> => ({ ...minimalRows().financial_events[0]!, event_id: id, ...fields });
const history = (dates = weekly, fields: Record<string, string> = {}): Record<string, string>[] => dates.map((value, index) => event("fact-" + index, { event_date: value, settlement_date: value, ...fields }));

test("fixed weekly interval is derived from observations", () => {
  const result = detectSeries(observations(weekly), date("2025-08-01"));
  assert.equal(result[0]!.schedule.kind, "fixed_interval_days"); assert.equal(result[0]!.schedule.intervalDays, 7);
  assert.equal(result[0]!.expectedNextOccurrence!.toISODateString(), "2025-08-05"); assert.equal(result[0]!.support, "supported");
});
test("biweekly recurrence", () => {
  const schedule = detectSchedule(observations(["2025-06-01", "2025-06-15", "2025-06-29", "2025-07-13"]), recurrencePolicy);
  assert.equal(schedule.intervalDays, 14);
});
test("nonstandard interval comes from gaps rather than a hardcoded interval list", () => {
  const schedule = detectSchedule(observations(["2025-07-01", "2025-07-10", "2025-07-19", "2025-07-28"]), recurrencePolicy);
  assert.equal(schedule.intervalDays, 9);
});
test("calendar-monthly cadence differs from thirty-day cadence", () => {
  const series = detectSeries(observations(["2025-04-15", "2025-05-15", "2025-06-15", "2025-07-15"]), date("2025-08-01"))[0]!;
  assert.equal(series.schedule.kind, "calendar_monthly"); assert.equal(series.schedule.anchorDay, 15);
  assert.equal(series.expectedNextOccurrence!.toISODateString(), "2025-08-15");
});
test("month-end anchor does not drift after February", () => {
  const series = detectSeries(observations(["2025-01-31", "2025-02-28", "2025-03-31"]), date("2025-04-01"))[0]!;
  assert.equal(series.schedule.monthEnd, true); assert.equal(series.expectedNextOccurrence!.toISODateString(), "2025-04-30");
  assert.equal(date("2025-02-28").addCalendarMonths(1, 31, true).toISODateString(), "2025-03-31");
});
test("leap-year monthly rule retains original day thirty-one", () => {
  const series = detectSeries(observations(["2024-01-31", "2024-02-29", "2024-03-31"]), date("2024-04-01"))[0]!;
  assert.equal(series.expectedNextOccurrence!.toISODateString(), "2024-04-30");
  assert.equal(date("2024-01-31").addCalendarMonths(1, 31).toISODateString(), "2024-02-29");
  assert.equal(date("2024-02-29").addCalendarMonths(1, 31).toISODateString(), "2024-03-31");
});
test("day thirty clipping is distinct from month-end semantics", () => {
  const series = detectSeries(observations(["2025-01-30", "2025-02-28", "2025-03-30"]), date("2025-04-01"))[0]!;
  assert.equal(series.schedule.anchorDay, 30); assert.equal(series.schedule.monthEnd, false);
  assert.equal(date("2025-02-28").addCalendarMonths(1, 30).toISODateString(), "2025-03-30");
  assert.throws(() => date("9999-12-31").addCalendarMonths(1, 31));
});
test("description normalization preserves meaningful numbers and symbols", () => {
  assert.equal(normalizeDescription('  HOME   Rent, Payment. '), "home rent payment");
  assert.notEqual(normalizeDescription("Plan 1"), normalizeDescription("Plan 2"));
  assert.notEqual(normalizeDescription("Plan A/B"), normalizeDescription("Plan AB"));
});
test("description policy does not merge unrelated descriptions", () => {
  const stream = observations(weekly).map((observation, index) => ({ ...observation, description: index % 2 ? "rent a" : "rent b" }));
  assert.equal(groupObservations(stream, { ...recurrencePolicy, grouping: "description" }).size, 2);
});
test("category grouping joins rotating variable merchants", () => {
  const stream = observations(weekly, ["10", "12", "9", "13", "11"], { category: "groceries" }).map((observation, index) => ({ ...observation, description: "merchant " + index }));
  const result = detectSeries(stream, date("2025-08-01"), { ...recurrencePolicy, grouping: "category" });
  assert.equal(result.length, 1); assert.equal(result[0]!.observationCount, 5); assert.equal(result[0]!.schedule.intervalDays, 7);
});
test("hybrid separates an established fixed bill from variable spending in its category", () => {
  const bill = observations(["2025-05-01", "2025-06-01", "2025-07-01"], ["30"], { category: "utilities", description: "fixed internet bill" });
  const variable = observations(["2025-07-02", "2025-07-09", "2025-07-16", "2025-07-23"], ["8", "9", "7", "10"], { category: "utilities" }).map((observation, index) => ({ ...observation, eventId: "variable-" + index, description: "provider " + index }));
  for (const grouping of ["category", "hybrid"] as const) {
    const groups = groupObservations([...bill, ...variable], { ...recurrencePolicy, grouping });
    assert.equal(groups.size, 2); assert.deepEqual([...groups.values()].map((members) => members.length).sort(), [3, 4]);
    const pooledSignature = [...groups.entries()].find(([, members]) => members.length === 4)![0];
    assert.equal(observationMatches(pooledSignature, bill[0]!), false, "Pooled signature cannot later absorb a protected fixed bill");
  }
});
test("two observations are diagnostic candidates rather than trusted commitments", () => {
  const series = detectSeries(observations(weekly.slice(0, 2)), date("2025-07-09"))[0]!;
  assert.equal(series.support, "low"); assert.equal(series.status, "ambiguous");
});
test("irregular sequences remain unsupported", () => {
  const series = detectSeries(observations(["2025-01-01", "2025-01-04", "2025-01-20", "2025-02-08", "2025-03-31"]), date("2025-04-01"))[0]!;
  assert.equal(series.schedule.kind, "unsupported"); assert.equal(series.status, "ambiguous"); assert.equal(series.expectedNextOccurrence, null);
});
test("one irregular gap is reported rather than silently discarded", () => {
  const dates = ["2025-06-01", "2025-06-08", "2025-06-15", "2025-06-22", "2025-06-29", "2025-07-07"];
  const series = detectSeries(observations(dates), date("2025-07-08"))[0]!;
  assert.equal(series.schedule.intervalDays, 7); assert.ok(series.diagnostics.includes("observed_date_deviations"));
});
test("stale series is not continued indefinitely", () => {
  const series = detectSeries(observations(weekly), date("2025-12-01"))[0]!;
  assert.equal(series.status, "inactive"); assert.equal(series.expectedNextOccurrence, null); assert.ok(series.missedOccurrences > 2);
});
test("missed expense occurrence remains explicitly conservative ambiguity", () => {
  const series = detectSeries(observations(weekly), date("2025-08-06"))[0]!;
  assert.equal(series.status, "ambiguous"); assert.equal(series.missedOccurrences, 1);
});
test("salary needs five continuous observations and loses future date after a missed occurrence", () => {
  const income = observations(weekly, ["100"], { direction: "credit", eventType: "income", category: "salary", description: "payroll" });
  assert.equal(detectSeries(income.slice(0, 2), date("2025-07-09"))[0]!.expectedNextOccurrence, null);
  assert.equal(detectSeries(income, date("2025-08-01"))[0]!.support, "strong");
  const stale = detectSeries(income, date("2025-08-06"))[0]!;
  assert.equal(stale.status, "inactive"); assert.equal(stale.expectedNextOccurrence, null);
});
test("seasonal and old employer income remain untrusted even with repeated cadence", () => {
  for (const description of ["seasonal wages", "previous employer payroll", "temporary assignment pay"]) {
    const series = detectSeries(observations(weekly, ["100"], { direction: "credit", eventType: "income", category: "salary", description }), date("2025-08-01"))[0]!;
    assert.equal(series.status, "ambiguous"); assert.equal(series.expectedNextOccurrence, null);
  }
});
test("bonuses and commissions cannot enter training even when category is salary", async (context) => {
  const { state } = await prepare(context, [...history(weekly, { event_type: "income", direction: "credit", category: "salary", description: "Employer commission" }),
    event("bonus", { event_type: "income", direction: "credit", category: "salary", description: "Quarterly bonus" })]);
  const result = analyzeRecurrence(state); assert.equal(result.observations.length, 0);
  assert.ok(result.exclusions.every((exclusion) => exclusion.reasons.includes("irregular_or_one_time_purpose")));
});
test("refunds and every investment type are excluded", async (context) => {
  const { state } = await prepare(context, [event("refund", { event_type: "refund", direction: "credit" }),
    event("purchase", { event_type: "investment_purchase" }), event("sale", { event_type: "investment_sale", direction: "credit" }),
    event("valuation", { event_type: "investment_valuation", status: "unrealized", direction: "non_cash", settlement_date: "" })]);
  const result = analyzeRecurrence(state); assert.equal(result.observations.length, 0);
  assert.equal(result.exclusions.filter((exclusion) => exclusion.reasons.includes("investment")).length, 3);
  assert.ok(result.exclusions.find((exclusion) => exclusion.eventId === "refund")!.reasons.includes("refund"));
});
test("pending, failed, cancelled, future and same-day records are excluded", async (context) => {
  const { state } = await prepare(context, [event("pending", { status: "pending" }), event("failed", { status: "failed" }),
    event("cancelled", { status: "cancelled" }), event("future", { status: "scheduled", settlement_date: "2025-08-05" }),
    event("same-day", { settlement_date: "2025-08-01" })]);
  const result = analyzeRecurrence(state); assert.equal(result.observations.length, 0);
  assert.ok(result.exclusions.every((exclusion) => exclusion.reasons.includes("not_prior_settled_cash")));
});
test("missing amount is excluded while reported zero remains a genuine observation", async (context) => {
  const { state } = await prepare(context, [event("missing", { amount: "" }), event("zero", { amount: "0.00" })]);
  const result = analyzeRecurrence(state); assert.equal(result.observations.length, 1); assert.equal(result.observations[0]!.amount.toExactDecimalString(), "0");
  assert.ok(result.exclusions.find((exclusion) => exclusion.eventId === "missing")!.reasons.includes("unresolved_amount"));
});
test("ambiguous lifecycle members are excluded", async (context) => {
  const { state } = await prepare(context, [event("first"), event("disputed", { linked_event_id: "first", settlement_date: "2025-07-02", event_date: "2025-07-02" })]);
  const result = analyzeRecurrence(state); assert.equal(result.observations.length, 0);
  assert.ok(result.exclusions.every((exclusion) => exclusion.reasons.includes("ambiguous_lifecycle")));
  assert.equal(eligibleHistorical(state, date("2025-07-02")).observations.length, 1, "Later dispute must not censor earlier training");
});
test("pending disputed link quarantines its historical debit despite future settlement date", async (context) => {
  const { state } = await prepare(context, [event("historical-debit"), event("pending-dispute", { status: "pending", linked_event_id: "historical-debit", event_date: "2025-07-30", settlement_date: "2025-08-05" })]);
  const result = analyzeRecurrence(state);
  assert.equal(result.observations.length, 0);
  assert.ok(result.exclusions.every((exclusion) => exclusion.reasons.includes("ambiguous_lifecycle")));
  assert.equal(eligibleHistorical(state, date("2025-07-02")).observations.length, 1);
});
test("unestablished transfers and windfalls cannot become recurring income", async (context) => {
  const { state } = await prepare(context, [...history(weekly, { event_type: "income", direction: "credit", description: "Internal transfer", category: "salary" }),
    event("windfall", { event_type: "income", direction: "credit", category: "windfall" })]);
  assert.equal(analyzeRecurrence(state).observations.length, 0);
});
test("an internal debit transfer is not established recurring spending", async (context) => {
  const { state } = await prepare(context, history(weekly, { description: "Internal transfer", category: "shopping" }));
  const result = analyzeRecurrence(state);
  assert.equal(result.observations.length, 0); assert.ok(result.exclusions.every((exclusion) => exclusion.reasons.includes("internal_transfer_unestablished")));
});
test("foreign series uses original currency and amounts despite changing FX rates", async (context) => {
  const { state } = await prepare(context, history(weekly, { currency: "USD", amount: "1.25" }), (rows) => {
    rows.exchange_rates = weekly.map((value, index) => ({ rate_date: value, from_currency: "USD", to_currency: "INR", rate: String(80 + index) }));
  });
  const series = analyzeRecurrence(state).series[0]!;
  assert.equal(series.currency, "USD"); assert.equal(series.amountModel, "fixed"); assert.equal(exactAmount(series.estimatedAmount), "5/4");
  assert.ok(series.provenance.every((source) => source.filename === "financial_events.csv"));
});
test("an unresolved FX record cannot become a recurrence observation", async (context) => {
  const { state } = await prepare(context, history());
  const broken = { ...state, records: state.records.map((record, index) => index === 0 ? {
    ...record, conversion: null, cashFact: null, unresolvedReasons: ["missing_or_invalid_fx"],
  } : record) };
  const result = analyzeRecurrence(broken);
  assert.equal(result.observations.length, 4);
  assert.ok(result.exclusions.find((exclusion) => exclusion.eventId === "fact-0")!.reasons.includes("unresolved_cash_or_fx"));
});
test("all amount estimators remain exact including repeating means", () => {
  const stream = observations(weekly, ["1", "2", "4", "8", "16"]);
  const expected = { last: "16", mean: "31/5", median: "4", recent_median: "8", upper_quantile: "8", lower_quantile: "1", maximum: "16", minimum: "1" };
  for (const [estimator, value] of Object.entries(expected)) assert.equal(exactAmount(estimateAmount(stream, estimator as RecurrencePolicy["expenseEstimator"], 3)), value);
  assert.equal(exactAmount(estimateAmount(stream.slice(0, 3), "mean", 3)), "7/3");
  assert.equal(exactAmount(estimateAmount(observations(weekly.slice(0, 2), ["0.1", "0.2"]), "median", 3)), "3/20");
});
test("direction-aware policy estimates expenses above income on variable observations", () => {
  const expenses = observations(weekly, ["10", "20", "30", "40", "50"]);
  const income = expenses.map((observation) => ({ ...observation, direction: "credit" as const, eventType: "income" as const, category: "salary", description: "payroll" }));
  const policy = { ...recurrencePolicy, expenseEstimator: "upper_quantile" as const, incomeEstimator: "lower_quantile" as const };
  assert.equal(exactAmount(detectSeries(expenses, date("2025-08-01"), policy)[0]!.estimatedAmount), "40");
  assert.equal(exactAmount(detectSeries(income, date("2025-08-01"), policy)[0]!.estimatedAmount), "10");
});
test("demonstrably fixed series preserves its amount instead of a variable estimator", () => {
  const series = detectSeries(observations(weekly, ["100.0000"]), date("2025-08-01"))[0]!;
  assert.equal(series.amountModel, "fixed"); assert.equal(exactAmount(series.estimatedAmount), "100");
});
test("IDs and ordering are deterministic and independent of input array positions", () => {
  const stream = observations(weekly); const first = detectSeries(stream, date("2025-08-01")); const reverse = detectSeries([...stream].reverse(), date("2025-08-01"));
  assert.deepEqual(reverse, first); assert.match(first[0]!.id, /^series-[0-9a-f]{64}$/);
  assert.equal(first[0]!.supportingEventIds.length, first[0]!.provenance.length);
});
test("explicit future commitment is a separate reference rather than a training observation", async (context) => {
  const { state } = await prepare(context, [...history(), event("supplied", { status: "scheduled", event_date: "2025-08-02", settlement_date: "2025-08-05" })]);
  const result = analyzeRecurrence(state); assert.equal(result.observations.length, 5);
  assert.deepEqual(result.series[0]!.suppliedFutureEventIds, ["supplied"]);
  assert.ok(!result.series[0]!.supportingEventIds.includes("supplied"));
});
test("rolling origins predict each withheld next observation from only its prefix", async (context) => {
  const { state } = await prepare(context, history());
  const predictions = rollingPredictions(state, { ...recurrencePolicy, minimumExpenseObservations: 3 });
  assert.equal(predictions.length, 2); assert.deepEqual(predictions.map((prediction) => prediction.trainingEventIds.length), [3, 4]);
  assert.ok(predictions.every((prediction) => prediction.trainingLastDate < prediction.actualDate));
  assert.ok(predictions.every((prediction) => prediction.absoluteDayError === 0));
});
test("modifying data after a cutoff cannot change an earlier prediction", async (context) => {
  const { state } = await prepare(context, history());
  const modifiedEvents = history(); modifiedEvents[4] = event("changed-future", { amount: "999999", description: "Different future purpose", event_date: "2025-07-30", settlement_date: "2025-07-30" });
  const { state: modified } = await prepare(context, modifiedEvents);
  const project = (source: typeof state) => rollingOrigins(source, recurrencePolicy).filter((origin) => origin.series.lastObservedDate.toISODateString() <= "2025-07-15")
    .map((origin) => ({ training: origin.series.supportingEventIds, predicted: origin.series.expectedNextOccurrence!.toISODateString(), amount: origin.series.estimatedAmount }));
  assert.deepEqual(project(modified), project(state)); assert.ok(project(state).length > 0);
});
test("future dispute does not alter prior rolling predictions", async (context) => {
  const { state } = await prepare(context, [...history(), event("future-dispute", { linked_event_id: "fact-0", event_date: "2025-07-30", settlement_date: "2025-07-30" })]);
  const prediction = rollingOrigins(state, recurrencePolicy).find((origin) => origin.series.lastObservedDate.toISODateString() === "2025-07-15")!;
  assert.ok(prediction); assert.equal(prediction.series.observationCount, 3); assert.equal(prediction.series.expectedNextOccurrence!.toISODateString(), "2025-07-22");
});
test("a later dispute cannot retrospectively censor an already withheld target or its error", async (context) => {
  const { state } = await prepare(context, history());
  const { state: disputed } = await prepare(context, [...history(), event("late-dispute", {
    linked_event_id: "fact-3", event_date: "2025-07-30", settlement_date: "2025-07-30",
  })]);
  const first = (source: typeof state) => rollingPredictions(source, recurrencePolicy).find((prediction) => prediction.trainingLastDate === "2025-07-15");
  assert.equal(first(state)!.actualEventId, "fact-3");
  assert.deepEqual(first(disputed), first(state));
  const metrics = backtestPolicy([disputed], recurrencePolicy);
  assert.equal(metrics.eligibleObservations, 5, "coverage uses eligibility when observed, not final dispute censoring");
  assert.equal(metrics.snapshotEligibleObservations, 4);
  assert.equal(metrics.coverage, "2/5");
});
test("backtest safety metrics distinguish expense underestimation from conservative error", async (context) => {
  const events = history(); events.forEach((row, index) => { row.amount = String(10 + index * 10); });
  const { state } = await prepare(context, events);
  const metrics = backtestPolicy([state], { ...recurrencePolicy, expenseEstimator: "last" });
  assert.equal(metrics.withheldPredictions, 2); assert.equal(metrics.expenseUnderestimates, 2); assert.equal(metrics.expenseOverestimates, 0);
  assert.equal(metrics.amountByCurrency.INR!.expense_under_magnitude, "20");
  assert.notEqual(metrics.unsafeRelativeError, "0"); assert.equal(metrics.conservativeRelativeError, "0");
});
test("income overestimation is unsafe while income underestimation is conservative", async (context) => {
  const dates = [...weekly, "2025-08-05", "2025-08-12"];
  const events = history(dates, { event_type: "income", direction: "credit", category: "salary", description: "payroll" });
  events.forEach((row, index) => { row.amount = String(100 - index * 10); });
  const { state } = await prepare(context, events, (rows) => { rows.requests[0]!.request_date = "2025-08-15"; });
  const metrics = backtestPolicy([state], { ...recurrencePolicy, incomeEstimator: "last" });
  assert.equal(metrics.incomeOverestimates, 2); assert.equal(metrics.incomeUnderestimates, 0);
});
test("unsafe income prediction against actual zero still incurs selection loss", async (context) => {
  const dates = [...weekly, "2025-08-05"];
  const events = history(dates, { event_type: "income", direction: "credit", category: "salary", description: "payroll" });
  events[5]!.amount = "0";
  const { state } = await prepare(context, events, (rows) => { rows.requests[0]!.request_date = "2025-08-06"; });
  const metrics = backtestPolicy([state], { ...recurrencePolicy, incomeEstimator: "last" });
  assert.equal(metrics.incomeOverestimates, 1); assert.equal(metrics.relativeErrorCount, 0);
  assert.equal(metrics.unsafeIncomeLoss, "1", "zero actual is penalized by the first lexicographic objective");
});
const futureMutations: Readonly<Record<string, (rows: Record<string, string>[]) => void>> = {
  amount: (rows) => { rows[4]!.amount = "999999999999999999999.000001"; },
  date: (rows) => { rows[4]!.event_date = "2025-07-31"; rows[4]!.settlement_date = "2025-07-31"; },
  description: (rows) => { rows[4]!.description = "Entirely different future purpose"; },
  "refund/dispute link": (rows) => { rows.push(event("future-refund", { event_type: "refund", direction: "credit", linked_event_id: "fact-3", event_date: "2025-07-30", settlement_date: "2025-07-30" })); rows.push(event("future-dispute", { linked_event_id: "fact-0", event_date: "2025-07-31", settlement_date: "2025-07-31" })); },
  status: (rows) => { rows[4]!.status = "failed"; },
  outlier: (rows) => { rows.push(event("future-outlier", { amount: "1000000", event_date: "2025-07-30", settlement_date: "2025-07-30" })); },
  "series ending": (rows) => { rows.splice(4); },
};
for (const [name, mutate] of Object.entries(futureMutations)) test("temporal purity: future " + name + " cannot affect any earlier inference field", async (context) => {
  const { state } = await prepare(context, history()); const changed = history(); mutate(changed);
  const { state: modified } = await prepare(context, changed);
  const cutoff = date("2025-07-16");
  assert.deepEqual(eligibleHistorical(modified, cutoff), eligibleHistorical(state, cutoff), "prefix eligibility and exclusions are identical");
  const earlier = (source: typeof state) => rollingOrigins(source, recurrencePolicy).filter((origin) => origin.series.lastObservedDate.compare(cutoff) < 0)
    .map(({ key, series }) => ({ key, ...series, firstObservedDate: series.firstObservedDate.toISODateString(), lastObservedDate: series.lastObservedDate.toISODateString(),
      expectedNextOccurrence: series.expectedNextOccurrence?.toISODateString() ?? null }));
  assert.ok(earlier(state).length > 0); assert.deepEqual(earlier(modified), earlier(state));
  const scoredBeforeMutation = (source: typeof state) => rollingPredictions(source, recurrencePolicy).filter((prediction) => prediction.actualDate <= "2025-07-22");
  assert.deepEqual(scoredBeforeMutation(modified), scoredBeforeMutation(state), "earlier targets and errors are not censored retroactively");
});
test("activity policy marks ended expense for review and never treats its absence as cancellation", () => {
  const series = detectSeries(observations(weekly), date("2025-12-01"))[0]!;
  assert.equal(series.status, "inactive"); assert.equal(series.expenseContinuity, "must_review");
  assert.equal(series.activityPolicy, "provisional"); assert.equal(series.activityConfidence, "uncertain");
  assert.equal(series.expectedNextOccurrence, null); assert.ok(series.diagnostics.includes("expense_continuity_requires_review_not_cancellation"));
});
test("old salary ending cannot remain eligible income", () => {
  const series = detectSeries(observations(weekly, ["100"], { direction: "credit", eventType: "income", category: "salary", description: "payroll" }), date("2025-09-01"))[0]!;
  assert.equal(series.status, "inactive"); assert.equal(series.incomeInferenceEligible, false); assert.equal(series.expectedNextOccurrence, null);
});
test("seasonal gap is distinguished from an active regular stream", () => {
  const stream = observations(["2025-01-01", "2025-01-08", "2025-01-15", "2025-07-01", "2025-07-08", "2025-07-15"], ["100"], { direction: "credit", eventType: "income", category: "salary", description: "seasonal wages" });
  const series = detectSeries(stream, date("2025-07-16"), { ...recurrencePolicy, recentWindow: 3 })[0]!;
  assert.equal(series.status, "ambiguous"); assert.equal(series.incomeInferenceEligible, false); assert.equal(series.activityConfidence, "uncertain");
});
test("a new income series and a cadence regime change cannot gain strong continuity", () => {
  const series = detectSeries(observations(weekly.slice(0, 2), ["100"], { direction: "credit", eventType: "income", category: "salary" }), date("2025-07-09"))[0]!;
  assert.equal(series.status, "ambiguous"); assert.equal(series.incomeInferenceEligible, false); assert.equal(series.support, "low");
  const changed = detectSeries(observations(["2025-05-01", "2025-05-08", "2025-05-15", "2025-06-01", "2025-06-10", "2025-06-19", "2025-06-28", "2025-07-07", "2025-07-16"], ["100"], { direction: "credit", eventType: "income", category: "salary" }), date("2025-07-17"))[0]!;
  assert.equal(changed.regimeChanged, true); assert.equal(changed.incomeInferenceEligible, false);
});
test("reference amount is diagnostic only and cannot reduce the strict safety estimate", () => {
  const series = detectSeries(observations(weekly, ["10", "100", "20", "30", "40"]), date("2025-08-01"))[0]!;
  assert.equal(exactAmount(series.estimatedAmount), "100"); assert.equal(exactAmount(series.referenceAmount), "30");
  assert.equal(series.referenceAmountUse, "diagnostic_only");
});
test("error magnitudes, means and medians are exact and directional", async (context) => {
  const events = history(); ["0.1", "0.2", "0.3", "0.4", "0.6"].forEach((amount, index) => { events[index]!.amount = amount; });
  const { state } = await prepare(context, events);
  const metrics = backtestPolicy([state], { ...recurrencePolicy, expenseEstimator: "last" });
  const bucket = metrics.amountByCurrency.INR!;
  assert.equal(bucket.expense_under_magnitude, "3/10"); assert.equal(bucket.expense_under_mean, "3/20"); assert.equal(bucket.expense_under_median, "3/20");
  assert.equal(bucket.expense_absolute_error, "3/10"); assert.equal(bucket.expense_relative_error, "3/10");
});
test("same-day observations form one cutoff and never withhold half a day", async (context) => {
  const events = history(); events.push(event("separate-bill", { description: "Other bill", event_date: "2025-07-15", settlement_date: "2025-07-15" }));
  const { state } = await prepare(context, events);
  assert.equal(rollingPredictions(state, recurrencePolicy).length, 2);
});
test("training at or beyond the cutoff is rejected", () => {
  assert.throws(() => detectSeries(observations(weekly), date("2025-07-29")));
});
test("recent cadence changes remain explicit and do not restore unproven income", () => {
  const dates = ["2025-05-01", "2025-05-08", "2025-05-15", "2025-06-01", "2025-06-10", "2025-06-19", "2025-06-28", "2025-07-07", "2025-07-16"];
  const series = detectSeries(observations(dates, ["100"], { direction: "credit", eventType: "income", category: "salary", description: "payroll" }), date("2025-07-17"))[0]!;
  assert.equal(series.regimeChanged, true); assert.equal(series.status, "ambiguous"); assert.equal(series.expectedNextOccurrence, null);
});
test("exact rational arithmetic and presentation use explicit floor", () => {
  assert.equal(new ExactRatio(1n, 3n).add(new ExactRatio(2n, 3n)).toFractionString(), "1");
  assert.equal(new ExactRatio(-1n, 3n).toDisplayDecimal(2), "-0.34");
  assert.equal(new ExactRatio(1n, 3n).toDisplayDecimal(2), "0.33");
  assert.throws(() => new ExactRatio(1n, 0n));
});
test("apparent continuation after a series end is right-censored at the request boundary", async (context) => {
  const { state } = await prepare(context, history());
  assert.equal(backtestPolicy([state], recurrencePolicy).apparentEndChecks, 0);
  const { state: later } = await prepare(context, history(), (rows) => { rows.requests[0]!.request_date = "2025-08-20"; });
  const metrics = backtestPolicy([later], recurrencePolicy);
  assert.equal(metrics.apparentEndChecks, 1); assert.equal(metrics.apparentFalseContinuations, 1);
  assert.equal(analyzeRecurrence(later).series[0]!.status, "inactive");
});
test("small amount variation is labeled without silently replacing it by a fixed amount", () => {
  const stream = observations(weekly, ["100", "101", "99", "100", "100"]);
  const series = detectSeries(stream, date("2025-08-01"), { ...recurrencePolicy, fixedToleranceNumerator: 1, fixedToleranceDenominator: 20 })[0]!;
  assert.equal(series.amountBehavior, "stable_with_variation"); assert.notEqual(series.amountModel, "fixed");
  assert.equal(detectSeries(stream, date("2025-08-01"), { ...recurrencePolicy, fixedToleranceNumerator: 0 })[0]!.amountBehavior, "variable");
});
test("policy hashes include thresholds and are independent of property insertion order", () => {
  const reversed = Object.fromEntries(Object.entries(recurrencePolicy).reverse()) as unknown as RecurrencePolicy;
  assert.equal(policyHash(reversed), policyHash(recurrencePolicy));
  assert.notEqual(policyHash({ ...recurrencePolicy, dateToleranceDays: 2 }), policyHash(recurrencePolicy));
});
test("policy selection cannot admit weak income support or an income grace period", async (context) => {
  const { state } = await prepare(context, history());
  const metrics = candidatePolicies.map((policy) => backtestPolicy([state], policy));
  const selected = selectPolicy(metrics);
  assert.ok(selected.policy.minimumIncomeObservations >= 5); assert.equal(selected.policy.incomeMissedAllowance, 0);
});
test("policy objective penalizes over-reservation and has deterministic input-order-independent tie breaks", async (context) => {
  const { state } = await prepare(context, history());
  const metric = backtestPolicy([state], recurrencePolicy);
  const inflated = { ...metric, policy: { ...metric.policy, version: "inflated-reservation" }, selectionScore: new ExactRatio(100n).toFractionString(), overReservationCost: "100" };
  assert.equal(selectPolicy([inflated, metric]).policy.version, metric.policy.version);
  const tie = { ...metric, policy: { ...metric.policy, version: "a-tie" } };
  assert.equal(selectPolicy([metric, tie]).policy.version, "a-tie");
  assert.deepEqual(selectPolicy([metric, tie]), selectPolicy([tie, metric]));
  assert.ok(selectionObjective.second.includes("over-reservation"));
});
test("report rendering is deterministic, includes provenance, and derives every metric from its inputs", async (context) => {
  const { state } = await prepare(context, history()); const metric = backtestPolicy([state], recurrencePolicy);
  const metadata = { runtime: process.version, sourceCommit: "fixture-reference", sourceHash: "fixture-source-hash", inputHash: "fixture-input-hash", inputFiles: { "financial_events.csv": "input-bytes-hash" }, sourceFiles: { "evaluation/backtest.ts": "source-bytes-hash" } };
  const report = renderRecurrenceReport(metadata, [metric], 1);
  assert.equal(report, renderRecurrenceReport(metadata, [metric], 1)); assert.ok(report.endsWith("\n")); assert.ok(!report.includes("\r"));
  for (const required of [metadata.runtime, metadata.sourceCommit, metadata.sourceHash, metadata.inputHash, metric.policyHash, "expense_under", "Over-reservation", "NOT empirically validated"]) {
    // Directional monetary columns use human-readable headings rather than raw JSON keys.
    assert.ok(report.includes(required === "expense_under" ? "Expense under count/total/mean/median" : required), required);
  }
  assert.notEqual(renderRecurrenceReport(metadata, [{ ...metric, expenseOverestimates: 123 }], 1), report);
  assert.ok(!report.includes("affordable_now")); assert.ok(!report.includes("Private fixture evidence"));
});
test("recurrence and backtesting access only the production files without sample outputs", async (context) => {
  const { input } = await prepare(context, history());
  await mkdir(resolve(input.directory, "sample_requests.csv")); await mkdir(resolve(input.directory, "output.csv"));
  const opened: string[] = [];
  const loaded = await loadProduction(input.directory, async (path) => { opened.push(basename(path)); return readFile(path); });
  assert.deepEqual(opened, ["requests.csv", "financial_profiles.csv", "financial_events.csv", "request_payment_options.csv", "messages.csv", "images.csv", "exchange_rates.csv"]);
  const inspection = await buildIndexes(loaded, input.directory);
  const state = reconstructState(normalizeData(inspection), "purchase-alpha").state!;
  assert.equal(analyzeRecurrence(state).observations.length, 5); assert.ok(backtestPolicy([state], recurrencePolicy).withheldPredictions > 0);
  const main = fileURLToPath(new URL("../src/main.js", import.meta.url));
  const backtest = fileURLToPath(new URL("../evaluation/backtest.js", import.meta.url));
  const cli = spawnSync(process.execPath, [main, "inspect-recurrence", "--dataset", input.directory, "--request", "purchase-alpha"], { encoding: "utf8", cwd: dirname(input.directory) });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr); assert.ok(!cli.stdout.includes("Private fixture evidence"));
  const auditFree = spawnSync(process.execPath, [backtest, "--dataset", input.directory], { encoding: "utf8" });
  assert.equal(auditFree.status, 0, auditFree.stdout + auditFree.stderr); assert.ok(auditFree.stdout.includes('"selectedPolicy"'));
  const unknown = spawnSync(process.execPath, [main, "inspect-recurrence", "--dataset", input.directory, "--request", "unknown"], { encoding: "utf8" });
  assert.equal(unknown.status, 1); assert.ok(unknown.stdout.includes("UNKNOWN_REQUEST"));
});
