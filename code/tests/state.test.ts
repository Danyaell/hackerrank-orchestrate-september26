import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { minimalRows, fixture } from "./fixtures.js";
import type { FixtureRows } from "./fixtures.js";
import { loadProduction } from "../src/data/load.js";
import { buildIndexes } from "../src/data/indexes.js";
import { normalizeData } from "../src/data/normalize.js";
import { reconstructState } from "../src/finance/state.js";

const event = (id: string, fields: Record<string, string> = {}): Record<string, string> =>
  ({ ...minimalRows().financial_events[0]!, event_id: id, ...fields });
async function prepare(context: TestContext, events: Record<string, string>[], adjust?: (rows: FixtureRows) => void) {
  const rows = minimalRows();
  rows.financial_events = events;
  rows.images = [];
  rows.messages = [];
  adjust?.(rows);
  const input = await fixture(rows, false);
  context.after(input.cleanup);
  const inspection = await buildIndexes(await loadProduction(input.directory), input.directory);
  const original = JSON.stringify(inspection.tables);
  const data = normalizeData(inspection);
  assert.equal(JSON.stringify(inspection.tables), original, "Normalization must not mutate raw input");
  return { input, inspection, data, result: reconstructState(data, "purchase-alpha") };
}

test("normalization preserves raw decimals, currency, dates, references and provenance", async (context) => {
  const { data, inspection } = await prepare(context, [event("normal", { amount: "0001.2300", settlement_date: "2025-07-02" })]);
  const normalized = data.events[0]!;
  assert.equal(normalized.amount.kind, "resolved");
  if (normalized.amount.kind === "resolved") {
    assert.equal(normalized.amount.originalText, "0001.2300");
    assert.equal(normalized.amount.money.toExactDecimalString(), "1.23");
    assert.equal(normalized.amount.reportedZero, false);
  }
  assert.equal(normalized.source, inspection.tables.financial_events[0]!.source);
  assert.equal(normalized.eventDate.toISODateString(), "2025-07-01");
  assert.equal(normalized.settlementDate!.toISODateString(), "2025-07-02");
  assert.equal(normalized.linkedEventId, null);
  assert.equal(normalized.currency, "INR");
  assert.equal(normalized.status, "settled");
  assert.equal(data.paymentOptions[0]!.paymentAmount.toExactDecimalString(), "100");
});
test("historical settled movements are retained and never replayed against snapshot", async (context) => {
  const { result } = await prepare(context, [event("large-history", { amount: "99999999" })]);
  assert.equal(result.state!.startingBalance.toExactDecimalString(), "1000");
  assert.equal(result.state!.historicalCashFacts.length, 1);
  assert.equal(result.state!.historicalCashFacts[0]!.movement.toExactDecimalString(), "-99999999");
  assert.equal(result.state!.confirmedFutureCommitments.length, 0);
});
test("future scheduled debits and credits are dated commitments without continuation", async (context) => {
  const { result } = await prepare(context, [
    event("future-debit", { status: "scheduled", settlement_date: "2025-08-03" }),
    event("future-credit", { status: "scheduled", direction: "credit", event_type: "income", category: "salary", amount: "300", settlement_date: "2025-08-04" }),
  ]);
  assert.equal(result.state!.confirmedFutureCommitments.length, 2);
  assert.deepEqual(result.state!.confirmedFutureCommitments.map((fact) => fact.movement.toExactDecimalString()), ["300", "-50"]);
  assert.equal(result.state!.startingBalance.toExactDecimalString(), "1000");
});
test("supplied future settled cash is preserved as a dated future fact", async (context) => {
  const { result } = await prepare(context, [event("future-settlement", { settlement_date: "2025-08-03" })]);
  assert.equal(result.state!.confirmedFutureCommitments.length, 1);
  assert.equal(result.state!.historicalCashFacts.length, 0);
});
test("pending debit exposure occurs once and hold policies do not alter snapshot", async (context) => {
  const { result, data } = await prepare(context, [event("pending-hold", { status: "pending", settlement_date: "2025-08-03" })]);
  assert.equal(result.state!.pendingDebitExposures.length, 1);
  assert.equal(result.state!.pendingDebitExposures[0]!.cashFact, null);
  assert.equal(result.state!.pendingBalancePolicy, "unknown");
  for (const policy of ["includes_holds", "excludes_holds", "unknown"] as const) {
    const state = reconstructState(data, "purchase-alpha", policy).state!;
    assert.equal(state.startingBalance.toExactDecimalString(), "1000");
    assert.equal(state.pendingBalancePolicy, policy);
  }
});
test("pending refund is a claim and never available income", async (context) => {
  const { result } = await prepare(context, [
    event("expense"), event("refund", { event_type: "refund", direction: "credit", status: "pending", linked_event_id: "expense", settlement_date: "2025-08-03" }),
  ]);
  assert.equal(result.state!.pendingCreditClaims.length, 1);
  assert.equal(result.state!.confirmedFutureCommitments.length, 0);
  assert.equal(result.state!.pendingCreditClaims[0]!.cashFact, null);
  assert.equal(result.state!.lifecycleGroups[0]!.edges[0]!.kind, "pending_refund");
});
test("failed debt attempt and scheduled retry produce only one commitment", async (context) => {
  const { result } = await prepare(context, [
    event("failure", { status: "failed", event_type: "debt_payment" }),
    event("retry", { status: "scheduled", event_type: "debt_payment", linked_event_id: "failure", settlement_date: "2025-08-03" }),
  ]);
  assert.equal(result.state!.failedAttempts.length, 1);
  assert.equal(result.state!.failedAttempts[0]!.realizedCash, "none");
  assert.equal(result.state!.confirmedFutureCommitments.length, 1);
  assert.equal(result.state!.confirmedFutureCommitments[0]!.eventId, "retry");
  assert.equal(result.state!.lifecycleGroups[0]!.edges[0]!.kind, "debt_retry");
});
test("failed debt without a supplied retry preserves uncertain obligation without cash", async (context) => {
  const { result } = await prepare(context, [event("failed-debt", { status: "failed", event_type: "debt_payment" })]);
  assert.equal(result.state!.failedAttempts.length, 1);
  assert.equal(result.state!.ambiguousObligations.length, 1);
  assert.equal(result.state!.confirmedFutureCommitments.length, 0);
  assert.ok(result.issues.some((issue) => issue.code === "FAILED_DEBT_OBLIGATION_UNRESOLVED"));
});
test("invalid monetary text is rejected before normalization rather than becoming unresolved zero", async (context) => {
  const { result, data, inspection } = await prepare(context, [event("invalid-amount", { amount: "not-money" })]);
  assert.ok(inspection.issues.some((issue) => issue.code === "INVALID_FIELD" && issue.field === "amount"));
  assert.equal(data.events.length, 0);
  assert.equal(result.state, null);
  assert.ok(result.issues.some((issue) => issue.code === "INVALID_FIELD" && issue.field === "amount"));
});
test("cancelled authorization and settled replacement produce only settled cash", async (context) => {
  const { result } = await prepare(context, [
    event("authorization", { status: "cancelled" }),
    event("replacement", { linked_event_id: "authorization" }),
  ]);
  assert.equal(result.state!.cancelledAttempts.length, 1);
  assert.equal(result.state!.cancelledAttempts[0]!.cashFact, null);
  assert.equal(result.state!.historicalCashFacts.length, 1);
  assert.equal(result.state!.lifecycleGroups[0]!.edges[0]!.kind, "authorization_replacement");
});
test("settled refund preserves original debit and both historical provenances", async (context) => {
  const { result } = await prepare(context, [
    event("expense"), event("refund", { event_type: "refund", direction: "credit", linked_event_id: "expense", settlement_date: "2025-07-02" }),
  ]);
  assert.equal(result.state!.historicalCashFacts.length, 2);
  assert.deepEqual(result.state!.historicalCashFacts.map((fact) => fact.movement.toExactDecimalString()), ["-50", "50"]);
  assert.equal(result.state!.lifecycleGroups[0]!.edges[0]!.kind, "settled_refund");
  assert.deepEqual(result.state!.historicalCashFacts.map((fact) => fact.source.row), [1, 2]);
});
test("investment valuations remain non-cash and a settled sale follows actual direction", async (context) => {
  const { result } = await prepare(context, [
    event("purchase", { event_type: "investment_purchase", category: "investment", amount: "200" }),
    event("valuation", { event_type: "investment_valuation", direction: "non_cash", status: "unrealized", category: "investment", linked_event_id: "purchase", amount: "250", settlement_date: "" }),
    event("sale", { event_type: "investment_sale", direction: "credit", category: "investment", linked_event_id: "purchase", amount: "220", settlement_date: "2025-07-15" }),
  ]);
  assert.equal(result.state!.nonCashRecords.length, 1);
  assert.equal(result.state!.nonCashRecords[0]!.cashFact, null);
  assert.equal(result.state!.historicalCashFacts.length, 2);
  assert.deepEqual(result.state!.historicalCashFacts.map((fact) => fact.movement.toExactDecimalString()), ["-200", "220"]);
  assert.deepEqual(result.state!.lifecycleGroups[0]!.edges.map((edge) => edge.kind).sort(), ["investment_sale", "investment_valuation"]);
});
test("generic linked debits remain distinct and explicitly ambiguous", async (context) => {
  const { result } = await prepare(context, [event("first"), event("second", { linked_event_id: "first" })]);
  assert.equal(result.state!.historicalCashFacts.length, 2);
  assert.equal(new Set(result.state!.historicalCashFacts.map((fact) => fact.id)).size, 2);
  assert.equal(result.state!.lifecycleGroups[0]!.ambiguous, true);
  assert.equal(result.state!.ambiguousObligations.length, 2);
  assert.equal(result.state!.unresolvedRecords.length, 2);
  assert.ok(result.issues.some((issue) => issue.code === "AMBIGUOUS_LIFECYCLE"));
});
test("self-link blocks state reconstruction", async (context) => {
  const { result } = await prepare(context, [event("self", { linked_event_id: "self" })]);
  assert.equal(result.state, null);
  assert.ok(result.issues.some((issue) => issue.code === "SELF_EVENT_LINK"));
});
test("relationship cycle blocks state reconstruction", async (context) => {
  const { result } = await prepare(context, [event("first", { linked_event_id: "second" }), event("second", { linked_event_id: "first" })]);
  assert.equal(result.state, null);
  assert.ok(result.issues.some((issue) => issue.code === "CYCLIC_EVENT_LINK"));
});
test("cross-user links cannot enter lifecycle groups", async (context) => {
  const { result } = await prepare(context, [event("first", { linked_event_id: "foreign-owner" }), event("foreign-owner", { user_id: "person-beta" })], (rows) => {
    rows.financial_profiles.push({ ...rows.financial_profiles[0]!, user_id: "person-beta" });
    rows.requests.push({ ...rows.requests[0]!, request_id: "purchase-beta", user_id: "person-beta" });
    rows.request_payment_options.push({ ...rows.request_payment_options[0]!, payment_option_id: "offer-beta", request_id: "purchase-beta" });
  });
  assert.equal(result.state, null);
  assert.ok(result.issues.some((issue) => issue.code === "CROSS_USER_EVENT_LINK"));
});
test("duplicate identities with conflicting parents are invalid multi-parent relationships", async (context) => {
  const { result } = await prepare(context, [event("parent-a"), event("parent-b"),
    event("duplicate", { linked_event_id: "parent-a" }), event("duplicate", { linked_event_id: "parent-b" })]);
  assert.equal(result.state, null);
  assert.ok(result.issues.some((issue) => issue.code === "MULTIPLE_LIFECYCLE_PARENTS"));
  assert.ok(result.issues.some((issue) => issue.code === "DUPLICATE_EVENT_ID"));
});
test("missing amount is unresolved while a reported zero remains a zero fact", async (context) => {
  const { result, data } = await prepare(context, [event("missing", { amount: "" }), event("zero", { amount: "0.00" })]);
  assert.equal(data.events[0]!.amount.kind, "unresolved");
  assert.equal(data.events[1]!.amount.kind, "resolved");
  assert.equal(result.state!.unresolvedRecords.length, 1);
  assert.equal(result.state!.historicalCashFacts.length, 1);
  assert.equal(result.state!.historicalCashFacts[0]!.eventId, "zero");
  assert.equal(result.state!.historicalCashFacts[0]!.movement.toExactDecimalString(), "0");
});
test("missing foreign amount validates FX coverage without manufacturing money", async (context) => {
  const { result } = await prepare(context, [event("missing-foreign", { amount: "", currency: "USD" })], (rows) => {
    rows.exchange_rates = [{ rate_date: "2025-07-01", from_currency: "USD", to_currency: "INR", rate: "80" }];
  });
  assert.ok(result.state);
  assert.equal(result.state.records[0]!.conversion, null);
  assert.equal(result.state.historicalCashFacts.length, 0);
  assert.equal(result.state.unresolvedRecords.length, 1);
});
test("cash normalization uses settlement date rather than event or request date for FX", async (context) => {
  const { result } = await prepare(context, [event("foreign", { currency: "USD", amount: "1.25", settlement_date: "2025-07-02" })], (rows) => {
    rows.exchange_rates = [
      { rate_date: "2025-07-01", from_currency: "USD", to_currency: "INR", rate: "10" },
      { rate_date: "2025-07-02", from_currency: "USD", to_currency: "INR", rate: "80.123" },
    ];
  });
  const fact = result.state!.historicalCashFacts[0]!;
  assert.equal(fact.movement.toExactDecimalString(), "-100.15375");
  assert.equal(fact.conversion.rateSource!.row, 2);
});
test("missing directed FX blocks state rather than guessing a balance", async (context) => {
  const { result } = await prepare(context, [event("foreign", { currency: "EUR" })]);
  assert.equal(result.state, null);
  assert.ok(result.issues.some((issue) => issue.code === "FX_MISSING_RATE"));
});
test("failed and cancelled foreign attempts do not require cash conversion", async (context) => {
  const { result } = await prepare(context, [event("failure", { status: "failed", currency: "EUR" }), event("cancellation", { status: "cancelled", currency: "EUR" })]);
  assert.ok(result.state);
  assert.equal(result.state.historicalCashFacts.length, 0);
  assert.ok(result.state.records.every((record) => record.conversion === null && record.realizedCash === "none"));
});
test("same-day settled cash is explicit and never replayed against snapshot", async (context) => {
  const { result } = await prepare(context, [event("same-day", { settlement_date: "2025-08-01" })]);
  assert.equal(result.state!.sameDayCashFacts.length, 1);
  assert.equal(result.state!.historicalCashFacts.length, 0);
  assert.equal(result.state!.sameDayOrdering, "unresolved");
  assert.equal(result.state!.sameDaySnapshotPolicy, "unresolved");
  assert.equal(result.state!.startingBalance.toExactDecimalString(), "1000");
});
test("past scheduled obligations remain unresolved without inventing a retry date", async (context) => {
  const { result } = await prepare(context, [event("overdue", { status: "scheduled" })]);
  assert.equal(result.state!.confirmedFutureCommitments.length, 0);
  assert.equal(result.state!.ambiguousObligations.length, 1);
  assert.ok(result.issues.some((issue) => issue.code === "OVERDUE_SCHEDULED_EVENT"));
});
test("settled cash without settlement date fails explicitly", async (context) => {
  const { result } = await prepare(context, [event("undated", { settlement_date: "" })]);
  assert.equal(result.state, null);
  assert.ok(result.issues.some((issue) => issue.code === "STATE_MISSING_SETTLEMENT_DATE"));
});
test("state ordering and identities do not depend on raw row ordering", async (context) => {
  const { data, result } = await prepare(context, [event("z"), event("a", { linked_event_id: "z" })]);
  const reversed = reconstructState({ ...data, events: [...data.events].reverse() }, "purchase-alpha");
  assert.deepEqual(reversed.state!.records.map((record) => record.event.id), ["a", "z"]);
  assert.deepEqual(reversed.state!.historicalCashFacts.map((fact) => fact.id), result.state!.historicalCashFacts.map((fact) => fact.id));
  assert.deepEqual(reversed.state!.lifecycleGroups, result.state!.lifecycleGroups);
  assert.deepEqual(reversed.issues, result.issues);
});
test("unknown request fails and state CLI respects production/sample isolation", async (context) => {
  const { data, input } = await prepare(context, [event("history")]);
  assert.equal(reconstructState(data, "unknown").issues[0]!.code, "UNKNOWN_REQUEST");
  await mkdir(resolve(input.directory, "sample_requests.csv"));
  await mkdir(resolve(input.directory, "output.csv"));
  const main = fileURLToPath(new URL("../src/main.js", import.meta.url));
  const args = [main, "inspect-state", "--request", "purchase-alpha", "--dataset", input.directory];
  const valid = spawnSync(process.execPath, args, { cwd: dirname(input.directory), encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stdout + valid.stderr);
  assert.ok(valid.stdout.includes("pending balance policy: unknown"));
  assert.ok(!valid.stdout.includes("Private fixture evidence"));
  const unknown = spawnSync(process.execPath, [main, "inspect-state", "--dataset", input.directory, "--request", "unknown"], { encoding: "utf8" });
  assert.equal(unknown.status, 1);
  assert.ok(unknown.stdout.includes("UNKNOWN_REQUEST"));
});
