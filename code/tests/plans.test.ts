import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DateOnly } from "../src/core/dates.js";
import { Money } from "../src/core/money.js";
import { loadProduction } from "../src/data/load.js";
import { buildIndexes } from "../src/data/indexes.js";
import { normalizeData } from "../src/data/normalize.js";
import { reconstructState } from "../src/finance/state.js";
import { analyzeRecurrence } from "../src/finance/recurrence.js";
import { buildForecast } from "../src/finance/forecast.js";
import { calculateCapacity } from "../src/finance/capacity.js";
import { expandOption } from "../src/finance/options.js";
import { actionSets, applySpending, availableActions, validateAction } from "../src/finance/spending.js";
import { createPlan, firstRankingDifference, selectPlans, validatePlan } from "../src/finance/plans.js";
import { fixture, minimalRows } from "./fixtures.js";
import type { FixtureRows } from "./fixtures.js";
import type { InternalPaymentPlan, SpendingAction } from "../src/domain.js";

const money = (value: string) => Money.fromDecimalString(value, "INR");
const date = (value: string) => DateOnly.parse(value);
const event = (id: string, fields: Record<string, string> = {}): Record<string, string> => ({ ...minimalRows().financial_events[0]!, event_id: id, ...fields });
const future = (id: string, fields: Record<string, string> = {}) => event(id, { status: "scheduled", event_date: "2025-08-01", settlement_date: "2025-08-02", ...fields });
const monthly = (flexibility = "reducible", floor = "20", name = "Gym") => ["2025-05-05", "2025-06-05", "2025-07-05"].map((value, index) => event(name + "-" + index, { event_date: value, settlement_date: value, description: name, category: "gym", flexibility, minimum_allowed_amount: floor, amount: "100" }));
const offer = (fields: Record<string, string> = {}) => ({ ...minimalRows().request_payment_options[0]!, payment_method: "installments", number_of_payments: "3", payment_amount: "40", payment_frequency_days: "14", financing_fee: "20", total_payable_amount: "120", ...fields });
const flexible = (rows: FixtureRows): void => {
  Object.assign(rows.financial_profiles[0]!, { current_available_balance: "400", expense_categories_user_is_willing_to_reduce: "gym", expense_categories_user_is_willing_to_stop: "gym" });
  rows.requests[0]!.requested_amount = "200";
};
async function prepare(context: TestContext, events: Record<string, string>[] = [], adjust?: (rows: FixtureRows) => void) {
  const rows = minimalRows(); rows.financial_events = events; rows.messages = []; rows.images = []; adjust?.(rows);
  const input = await fixture(rows, false); context.after(input.cleanup);
  const inspection = await buildIndexes(await loadProduction(input.directory), input.directory);
  assert.deepEqual(inspection.issues.filter((issue) => issue.severity === "error"), []);
  const data = normalizeData(inspection), result = reconstructState(data, "purchase-alpha"); assert.ok(result.state);
  const state = result.state, recurrence = analyzeRecurrence(state), forecast = buildForecast(state, data.fx, recurrence), baseline = calculateCapacity(state, forecast);
  return { state, recurrence, forecast, baseline, data, input, selection: selectPlans(state, forecast, recurrence, data.fx, data.paymentOptions) };
}
const has = (issues: readonly { code: string }[], code: string) => issues.some((issue) => issue.code === code);

test("full payment today needs no option and is simulated in four scenarios", async (context) => {
  const input = await prepare(context);
  const selection = selectPlans(input.state, input.forecast, input.recurrence, input.data.fx, []);
  assert.equal(selection.selected?.method, "full_payment"); assert.equal(selection.selected.optionId, null);
  assert.equal(selection.selected.payments[0]!.amount.toExactDecimalString(), "100");
  assert.equal(selection.validCandidates[0]!.validation.scenarios.length, 4);
  assert.ok(selection.validCandidates[0]!.validation.scenarios.every((scenario) => scenario.safe));
});
test("wait is the baseline later date and requires full-payment acceptance", async (context) => {
  const { selection } = await prepare(context, [future("income", { direction: "credit", event_type: "income", category: "salary", amount: "200" })], (rows) => { rows.financial_profiles[0]!.current_available_balance = "100"; });
  assert.equal(selection.selected?.method, "wait"); assert.equal(selection.selected.payments[0]!.date.toISODateString(), "2025-08-03");
  assert.equal(selection.selected.payments.length, 1);
});
test("partial payment uses exactly the unchanged baseline capacity and remainder", async (context) => {
  const { selection } = await prepare(context, [future("income", { direction: "credit", event_type: "income", category: "salary", amount: "50" })], (rows) => { Object.assign(rows.financial_profiles[0]!, { current_available_balance: "150", payment_methods_user_will_consider: "partial_payment" }); });
  assert.equal(selection.selected?.method, "partial_payment"); assert.equal(selection.baselineSafeToPay?.toExactDecimalString(), "50");
  assert.deepEqual(selection.selected.payments.map((payment) => [payment.date.toISODateString(), payment.amount.toExactDecimalString()]), [["2025-08-01", "50"], ["2025-08-03", "50"]]);
  assert.equal(selection.selected.totalPaid.toExactDecimalString(), "100");
});
test("a stale earliest-date hint cannot bypass complete partial schedule simulation", async (context) => {
  const input = await prepare(context, [future("income", { direction: "credit", event_type: "income", category: "salary", amount: "50" })], (rows) => { Object.assign(rows.financial_profiles[0]!, { current_available_balance: "150", payment_methods_user_will_consider: "partial_payment" }); });
  // The actual baseline date is Aug 3. A non-authoritative Aug 2 hint would
  // spend the remainder before the same-day credit; the simulator must reject it.
  const hint = { ...input.baseline, earliestFullPaymentDate: date("2025-08-02") };
  const plan = createPlan(input.state, "partial_payment", [{ date: input.state.request.date, amount: money("50") }, { date: hint.earliestFullPaymentDate, amount: money("50") }]);
  const result = validatePlan(input.state, input.forecast, hint, plan, input.recurrence, input.data.fx, []);
  assert.equal(result.valid, false); assert.ok(has(result.issues, "PLAN_MINIMUM_BREACH"));
  assert.ok(result.scenarios.every((scenario) => scenario.breaches.some((breach) => breach.date.equals(hint.earliestFullPaymentDate))));
});
test("partial payment is rejected without request permission", async (context) => {
  const { selection } = await prepare(context, [future("income", { direction: "credit", event_type: "income", category: "salary", amount: "50" })], (rows) => { rows.requests[0]!.allows_partial_payment = "false"; Object.assign(rows.financial_profiles[0]!, { current_available_balance: "150", payment_methods_user_will_consider: "partial_payment" }); });
  assert.equal(selection.selected, null); assert.ok(selection.rejectedCandidates.some((candidate) => has(candidate.issues, "PLAN_PARTIAL_BASELINE")));
});
test("partial payment beyond deadline is rejected", async (context) => {
  const { selection } = await prepare(context, [future("income", { direction: "credit", event_type: "income", category: "salary", amount: "50" })], (rows) => { rows.requests[0]!.desired_completion_date = "2025-08-02"; Object.assign(rows.financial_profiles[0]!, { current_available_balance: "150", payment_methods_user_will_consider: "partial_payment" }); });
  assert.equal(selection.selected, null); assert.ok(selection.absenceReasons.includes("deadline"));
});
test("installments retain every supplied date, fee, count and amount", async (context) => {
  const { data, selection } = await prepare(context, [], (rows) => { rows.request_payment_options = [offer()]; Object.assign(rows.financial_profiles[0]!, { payment_methods_user_will_consider: "installments", max_installment_months: "3" }); });
  const canonical = data.paymentOptions[0]!; assert.equal(canonical.method, "installments"); assert.equal(canonical.numberOfPayments, 3n); assert.equal(canonical.paymentFrequencyDays, 14n);
  assert.equal(selection.selected?.optionId, canonical.id); assert.equal(selection.selected.totalPaid.toExactDecimalString(), "120");
  assert.deepEqual(selection.selected.payments.map((payment) => [payment.date.toISODateString(), payment.amount.toExactDecimalString()]), [["2025-08-01", "40"], ["2025-08-15", "40"], ["2025-08-29", "40"]]);
});
test("inconsistent installment amounts are rejected without adjusted last payment", async (context) => {
  const { selection } = await prepare(context, [], (rows) => { rows.request_payment_options = [offer({ payment_amount: "33.33", financing_fee: "0", total_payable_amount: "100" })]; Object.assign(rows.financial_profiles[0]!, { payment_methods_user_will_consider: "installments", max_installment_months: "3" }); });
  assert.equal(selection.selected, null); assert.ok(has(selection.optionIssues, "OPTION_TOTAL_SUM")); assert.equal(selection.eligibleCandidates.length, 0);
});
test("installment total must equal requested principal plus fee", async (context) => {
  const { selection } = await prepare(context, [], (rows) => { rows.request_payment_options = [offer({ payment_amount: "50", total_payable_amount: "150" })]; Object.assign(rows.financial_profiles[0]!, { payment_methods_user_will_consider: "installments", max_installment_months: "3" }); });
  assert.ok(has(selection.optionIssues, "OPTION_TOTAL_PRICE_FEE")); assert.equal(selection.selected, null);
});
test("multi-payment installments require a supplied positive frequency", async (context) => {
  const input = await prepare(context, [], (rows) => { rows.request_payment_options = [offer({ payment_frequency_days: "" })]; Object.assign(rows.financial_profiles[0]!, { payment_methods_user_will_consider: "installments", max_installment_months: "3" }); });
  assert.ok(has(input.selection.optionIssues, "OPTION_FREQUENCY"));
  assert.ok(has(expandOption(input.state, input.forecast, { ...input.data.paymentOptions[0]!, paymentFrequencyDays: 0n }).issues, "OPTION_FREQUENCY"));
});
test("nonpositive and huge payment counts cannot become fabricated schedules", async (context) => {
  const input = await prepare(context, [], (rows) => { rows.request_payment_options = [offer()]; rows.financial_profiles[0]!.max_installment_months = "3"; });
  assert.ok(has(expandOption(input.state, input.forecast, { ...input.data.paymentOptions[0]!, numberOfPayments: 0n }).issues, "OPTION_PAYMENT_COUNT"));
  assert.equal(expandOption(input.state, input.forecast, { ...input.data.paymentOptions[0]!, numberOfPayments: 99999999999999999999n }).payments, null);
});
test("installment completion must satisfy deadline and forecast horizon", async (context) => {
  for (const frequency of ["20", "60"]) {
    const { selection } = await prepare(context, [], (rows) => { rows.request_payment_options = [offer({ payment_frequency_days: frequency })]; Object.assign(rows.financial_profiles[0]!, { payment_methods_user_will_consider: "installments", max_installment_months: "3" }); });
    assert.equal(selection.selected, null); assert.ok(selection.optionIssues.some((issue) => ["OPTION_DEADLINE", "OPTION_OUTSIDE_HORIZON"].includes(issue.code)));
  }
});
test("user payment preferences reject otherwise safe installments", async (context) => {
  const { selection } = await prepare(context, [], (rows) => { rows.request_payment_options = [offer()]; rows.financial_profiles[0]!.max_installment_months = "3"; });
  assert.equal(selection.selected?.method, "full_payment"); assert.ok(selection.rejectedCandidates.some((candidate) => candidate.method === "installments" && has(candidate.issues, "PLAN_PREFERENCE")));
});
test("invalid full-payment offer cannot disable option-independent full payment", async (context) => {
  const { selection } = await prepare(context, [], (rows) => { rows.request_payment_options = [minimalRows().request_payment_options[0]!]; rows.request_payment_options[0]!.payment_amount = "90"; });
  assert.equal(selection.selected?.method, "full_payment"); assert.equal(selection.selected.optionId, null); assert.ok(has(selection.optionIssues, "OPTION_TOTAL_SUM"));
});
test("conservative max-month comparator checks both count and anchored elapsed duration", async (context) => {
  const input = await prepare(context, [], (rows) => { rows.request_payment_options = [offer()]; rows.financial_profiles[0]!.max_installment_months = "2"; });
  const option = input.data.paymentOptions[0]!;
  assert.ok(has(expandOption(input.state, input.forecast, option).issues, "OPTION_MAX_INSTALLMENT_COUNT"));
  assert.equal(expandOption(input.state, input.forecast, option, "calendar_cap_only").issues.length, 0);
  const late = { ...option, numberOfPayments: 2n, paymentFrequencyDays: 62n, paymentAmount: money("60") };
  const state = { ...input.state, request: { ...input.state.request, deadline: date("2025-10-03") } };
  assert.ok(has(expandOption(state, input.forecast, late).issues, "OPTION_MAX_INSTALLMENT_DURATION"));
});
test("out-of-range installment calendar cap produces a structured rejection", async (context) => {
  const input = await prepare(context, [], (rows) => {
    Object.assign(rows.requests[0]!, { request_date: "9999-12-31", desired_completion_date: "9999-12-31" });
    rows.request_payment_options = [offer({ number_of_payments: "1", payment_amount: "100", financing_fee: "0", total_payable_amount: "100", first_payment_date: "9999-12-31" })];
    rows.financial_profiles[0]!.max_installment_months = "1";
  });
  assert.ok(has(input.selection.optionIssues, "OPTION_DATE_RANGE")); assert.equal(input.selection.selected, null);
});
test("actual selection prefers no changes when both full schedules are safe", async (context) => {
  const { selection } = await prepare(context, monthly(), (rows) => { flexible(rows); rows.financial_profiles[0]!.current_available_balance = "1000"; });
  assert.ok(selection.validCandidates.some((candidate) => candidate.plan.changes.length > 0));
  assert.equal(selection.selected?.changes.length, 0); assert.equal(selection.rankingTrace[0]!.firstDifferenceFromNext, 2);
});
test("actual selection chooses lower financing cost before option ID", async (context) => {
  const { selection } = await prepare(context, [], (rows) => {
    rows.request_payment_options = [offer({ payment_option_id: "a", payment_amount: "40" }), offer({ payment_option_id: "z", number_of_payments: "2", payment_amount: "55", financing_fee: "10", total_payable_amount: "110" })];
    Object.assign(rows.financial_profiles[0]!, { payment_methods_user_will_consider: "installments", max_installment_months: "3" });
  });
  assert.equal(selection.validCandidates.length, 2); assert.equal(selection.selected?.optionId, "z"); assert.equal(selection.rankingTrace[0]!.firstDifferenceFromNext, 3);
});
test("compatible two-action search retains a feasible plan that neither action alone enables", async (context) => {
  const { selection } = await prepare(context, ["A", "B"].flatMap((name) => monthly("stoppable", "", name)), (rows) => { flexible(rows); rows.financial_profiles[0]!.current_available_balance = "800"; rows.requests[0]!.requested_amount = "500"; });
  assert.equal(selection.search.actionSets, 4); assert.equal(selection.selected?.changes.length, 2);
  assert.ok(selection.validCandidates.every((candidate) => candidate.plan.changes.length === 2));
});

test("reducible expense can enable a fully simulated plan without changing baseline capacity", async (context) => {
  const { selection, baseline } = await prepare(context, monthly(), flexible);
  assert.equal(selection.selected?.changes[0]!.kind, "reduce_to"); assert.equal(selection.selected.changes[0]!.anchorEventId, "Gym-2");
  assert.equal(selection.selected.changes[0]!.amount?.toExactDecimalString(), "20"); assert.equal(selection.baselineSafeToPay?.toExactDecimalString(), "0");
  assert.equal(baseline.maximumImmediatePayment?.toExactDecimalString(), "0"); assert.ok(selection.validCandidates.every((candidate) => candidate.validation.scenarios.every((scenario) => scenario.safe)));
});
test("stoppable expense only yields stop and never invents a missing reduction floor", async (context) => {
  const { selection } = await prepare(context, monthly("stoppable", ""), flexible);
  assert.equal(selection.search.eligibleActions, 1); assert.equal(selection.selected?.changes[0]!.kind, "stop"); assert.ok(has(selection.spendingIssues, "CHANGE_MISSING_FLOOR"));
});
test("reducible-or-stoppable retains both non-conflicting action alternatives", async (context) => {
  const { selection } = await prepare(context, monthly("reducible_or_stoppable"), flexible);
  assert.equal(selection.search.eligibleActions, 2); assert.equal(selection.search.actionSets, 3);
  assert.ok(selection.validCandidates.some((candidate) => candidate.plan.changes[0]?.kind === "stop"));
  assert.ok(selection.validCandidates.some((candidate) => candidate.plan.changes[0]?.kind === "reduce_to"));
});
test("protected expense cannot change despite explicit user category permission", async (context) => {
  const { selection } = await prepare(context, monthly(), (rows) => { flexible(rows); rows.financial_profiles[0]!.expense_categories_to_protect = "gym"; });
  assert.equal(selection.search.eligibleActions, 0); assert.equal(selection.selected, null); assert.ok(has(selection.spendingIssues, "CHANGE_PROTECTED"));
});
test("unauthorized categories and fixed expenses cannot change", async (context) => {
  const unauthorized = await prepare(context, monthly(), (rows) => { flexible(rows); rows.financial_profiles[0]!.expense_categories_user_is_willing_to_reduce = ""; });
  assert.equal(unauthorized.selection.search.eligibleActions, 0); assert.ok(has(unauthorized.selection.spendingIssues, "CHANGE_UNAUTHORIZED"));
  const fixed = await prepare(context, monthly("fixed"), flexible); assert.equal(fixed.selection.search.eligibleActions, 0);
});
test("reduction cannot go below any supplied supporting floor", async (context) => {
  const input = await prepare(context, monthly(), flexible), action = availableActions(input.state, input.forecast, input.recurrence).actions[0]!;
  assert.ok(has(validateAction(input.state, input.forecast, input.recurrence, { ...action, amount: money("19.99") }), "CHANGE_MINIMUM_FLOOR"));
  assert.equal(applySpending(input.state, input.forecast, input.recurrence, [{ ...action, amount: money("19.99") }], input.data.fx).forecast, input.forecast);
});
test("reported zero floor remains zero while absent floor does not become zero", async (context) => {
  const zero = await prepare(context, monthly("reducible", "0"), flexible);
  assert.equal(zero.selection.selected?.changes[0]!.kind, "reduce_to"); assert.equal(zero.selection.selected.changes[0]!.amount?.toExactDecimalString(), "0");
  const absent = await prepare(context, monthly("reducible", ""), flexible);
  assert.equal(absent.selection.search.eligibleActions, 0); assert.ok(has(absent.selection.spendingIssues, "CHANGE_MISSING_FLOOR"));
});
test("maximum supplied supporting floor is preserved conservatively", async (context) => {
  const events = monthly(); events[0]!.minimum_allowed_amount = "40";
  const input = await prepare(context, events, flexible); assert.equal(availableActions(input.state, input.forecast, input.recurrence).actions[0]!.amount?.toExactDecimalString(), "40");
});
test("stop and reduction on the same series are rejected as conflicting", async (context) => {
  const input = await prepare(context, monthly("reducible_or_stoppable"), flexible), actions = availableActions(input.state, input.forecast, input.recurrence).actions;
  assert.ok(has(applySpending(input.state, input.forecast, input.recurrence, actions, input.data.fx).issues, "CHANGE_CONFLICT"));
  assert.ok(actionSets(actions).every((set) => set.length <= 1));
});
test("all compatible sets up to three actions are retained and four actions rejected", async (context) => {
  const input = await prepare(context, ["A", "B", "C", "D"].flatMap((name) => monthly("stoppable", "", name)), (rows) => { flexible(rows); rows.financial_profiles[0]!.current_available_balance = "5000"; });
  const actions = availableActions(input.state, input.forecast, input.recurrence).actions;
  assert.equal(actions.length, 4); assert.equal(actionSets(actions).length, 15); assert.ok(actionSets(actions).every((set) => set.length <= 3));
  assert.ok(has(applySpending(input.state, input.forecast, input.recurrence, actions, input.data.fx).issues, "CHANGE_LIMIT"));
});
test("a change with no effect during the entire horizon is excluded", async (context) => {
  const input = await prepare(context, monthly(), flexible), action = availableActions(input.state, input.forecast, input.recurrence).actions[0]!;
  assert.ok(has(validateAction(input.state, { ...input.forecast, movements: [] }, input.recurrence, action), "CHANGE_NO_FUTURE_EFFECT"));
});
test("spending changes never alter confirmed supplied commitments or raw history", async (context) => {
  const input = await prepare(context, [...monthly(), future("confirmed-gym", { settlement_date: "2025-08-05", amount: "100", description: "Gym", category: "gym", flexibility: "reducible", minimum_allowed_amount: "20" })], flexible);
  const action = availableActions(input.state, input.forecast, input.recurrence).actions[0]!, changed = applySpending(input.state, input.forecast, input.recurrence, [action], input.data.fx);
  const supplied = input.forecast.movements.find((movement) => movement.kind === "confirmed_future_commitment")!;
  assert.equal(changed.forecast.movements.find((movement) => movement.id === supplied.id), supplied); assert.equal(supplied.amount.toExactDecimalString(), "-100");
  assert.ok(input.state.records.filter((record) => record.category === "historical_settled").every((record) => record.event.amount.kind === "resolved" && record.event.amount.originalText === "100"));
  assert.equal(input.forecast.movements.filter((movement) => movement.kind === "generated_recurring_expense").length, 2);
});
test("changes start strictly after the request date without same-day savings", async (context) => {
  const events = monthly().map((row) => ({ ...row, event_date: row.event_date!.slice(0, 8) + "01", settlement_date: row.settlement_date!.slice(0, 8) + "01" }));
  const input = await prepare(context, events, flexible), action = availableActions(input.state, input.forecast, input.recurrence).actions[0]!;
  const sameDay = input.forecast.movements.find((movement) => movement.date.equals(input.state.request.date))!;
  const changed = applySpending(input.state, input.forecast, input.recurrence, [action], input.data.fx);
  assert.equal(changed.forecast.movements.find((movement) => movement.id === sameDay.id), sameDay); assert.equal(sameDay.amount.toExactDecimalString(), "-100");
});
test("changes cannot bypass pending-hold safety in the more conservative scenario", async (context) => {
  const { selection } = await prepare(context, [...monthly("stoppable", ""), future("pending", { status: "pending", settlement_date: "", amount: "80" })], (rows) => { flexible(rows); rows.requests[0]!.requested_amount = "50"; rows.financial_profiles[0]!.current_available_balance = "200"; });
  assert.equal(selection.selected, null);
  const stopped = selection.rejectedCandidates.find((candidate) => candidate.plan?.changes[0]?.kind === "stop")!;
  assert.ok(has(stopped.issues, "PLAN_MINIMUM_BREACH")); assert.ok(stopped.issues.some((issue) => issue.explanation.includes("excludes_holds")));
});
test("changes are validated against intraday checkpoints in both orderings", async (context) => {
  const input = await prepare(context, [...monthly("stoppable", ""), future("credit", { amount: "100", direction: "credit", event_type: "income", category: "salary", settlement_date: "2025-08-01" }), future("debit", { amount: "100", settlement_date: "2025-08-01" })], (rows) => { flexible(rows); rows.requests[0]!.requested_amount = "50"; rows.financial_profiles[0]!.current_available_balance = "200"; });
  assert.equal(input.selection.selected, null); assert.ok(input.selection.rejectedCandidates.some((candidate) => has(candidate.issues, "PLAN_MINIMUM_BREACH")));
});
test("blocked amount produces no safe candidate and retains structured absence reason", async (context) => {
  const { selection } = await prepare(context, [future("missing", { amount: "" })]);
  assert.equal(selection.baseline.status, "blocked"); assert.equal(selection.selected, null); assert.equal(selection.validCandidates.length, 0);
  assert.equal(selection.baselineSafeToPay, null); assert.deepEqual(selection.absenceReasons, ["blocked_input"]);
});
test("conservative unresolved liability produces no safe candidate", async (context) => {
  const { selection } = await prepare(context, [event("uncertain", { settlement_date: "2025-07-20", event_date: "2025-07-20" })]);
  assert.equal(selection.baseline.status, "conservative_unresolved"); assert.equal(selection.selected, null); assert.equal(selection.baselineSafeToPay, null);
  assert.deepEqual(selection.absenceReasons, ["conservative_unresolved_liability"]);
});
test("spending changes may repair a resolved baseline breach only after full simulation", async (context) => {
  const { selection } = await prepare(context, monthly("stoppable", ""), (rows) => { flexible(rows); rows.requests[0]!.requested_amount = "100"; rows.financial_profiles[0]!.current_available_balance = "250"; });
  assert.equal(selection.baseline.status, "baseline_unsafe"); assert.equal(selection.baselineSafeToPay, null);
  assert.equal(selection.selected?.changes[0]!.kind, "stop"); assert.ok(selection.validCandidates[0]!.validation.scenarios.every((scenario) => scenario.safe));
});
test("wrong-currency candidate is rejected structurally without arithmetic exception", async (context) => {
  const input = await prepare(context), plan = input.selection.selected!;
  const wrong = { ...plan, payments: [{ ...plan.payments[0]!, amount: Money.fromDecimalString("100", "USD") }] };
  assert.ok(has(validatePlan(input.state, input.forecast, input.baseline, wrong, input.recurrence, input.data.fx, []).issues, "PLAN_CURRENCY"));
});
test("unknown request fails clearly in the plan CLI", async (context) => {
  const input = await prepare(context), main = fileURLToPath(new URL("../src/main.js", import.meta.url));
  const result = spawnSync(process.execPath, [main, "inspect-plans", "--dataset", input.input.directory, "--request", "unknown-purchase"], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.match(result.stdout, /UNKNOWN_REQUEST/);
});
test("plan execution never opens sample outputs or imports evaluation modules", async (context) => {
  const input = await prepare(context);
  await mkdir(resolve(input.input.directory, "sample_requests.csv")); await mkdir(resolve(input.input.directory, "output.csv"));
  const opened: string[] = [];
  const inspection = await buildIndexes(await loadProduction(input.input.directory, async (path) => { opened.push(path); return readFile(path); }), input.input.directory);
  const data = normalizeData(inspection), state = reconstructState(data, "purchase-alpha").state!, recurrence = analyzeRecurrence(state);
  assert.equal(selectPlans(state, buildForecast(state, data.fx, recurrence), recurrence, data.fx, data.paymentOptions).selected?.method, "full_payment");
  assert.equal(opened.length, 7); assert.ok(opened.every((path) => !path.endsWith("sample_requests.csv") && !path.endsWith("output.csv")));
  const main = fileURLToPath(new URL("../src/main.js", import.meta.url));
  for (const command of ["inspect-plans", "inspect-plan-candidates", "inspect-plan-summary"]) {
    const result = spawnSync(process.execPath, [main, command, "--dataset", input.input.directory, ...(command === "inspect-plan-summary" ? [] : ["--request", "purchase-alpha"])], { cwd: dirname(input.input.directory), encoding: "utf8" });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.match(result.stdout, /PLAN_SUMMARY/);
    assert.doesNotMatch(result.stdout + result.stderr, /Private fixture evidence/);
  }
});

// Isolated comparator tests assert each specified criterion, without treating
// these comparison-only objects as financially validated candidates.
async function rankFixture(context: TestContext) {
  const input = await prepare(context), base = input.selection.selected!;
  const compare = (a: InternalPaymentPlan, b: InternalPaymentPlan, criterion: number) => { const result = firstRankingDifference(a, b, input.state.request.deadline); assert.equal(result.criterion, criterion); assert.ok(result.comparison < 0); };
  const action: SpendingAction = { kind: "stop", seriesId: "series", anchorEventId: "anchor", amount: null, provenance: [input.state.request.source] };
  return { ...input, base, compare, action };
}
test("ranking retains deadline completion as its first criterion", async (context) => { const { base, compare } = await rankFixture(context); compare(base, { ...base, payments: [{ date: date("2025-09-01"), amount: money("100") }] }, 1); });
test("ranking prefers no changes before comparing costs", async (context) => { const { base, compare, action } = await rankFixture(context); compare({ ...base, totalPaid: money("200") }, { ...base, changes: [action] }, 2); });
test("ranking compares exact total cost before first date", async (context) => { const { base, compare } = await rankFixture(context); compare({ ...base, payments: [{ date: date("2025-08-05"), amount: money("100") }] }, { ...base, totalPaid: money("100.00000000000000000001") }, 3); });
test("ranking prefers earlier first payment before fewer payments", async (context) => { const { base, compare } = await rankFixture(context); compare({ ...base, payments: [{ date: date("2025-08-01"), amount: money("50") }, { date: date("2025-08-02"), amount: money("50") }] }, { ...base, payments: [{ date: date("2025-08-02"), amount: money("100") }] }, 4); });
test("ranking prefers fewer payments before option identity", async (context) => { const { base, compare } = await rankFixture(context); compare({ ...base, optionId: "z" }, { ...base, optionId: "a", payments: [{ date: date("2025-08-01"), amount: money("50") }, { date: date("2025-08-02"), amount: money("50") }] }, 5); });
test("ranking uses lowest option ID with null after concrete IDs", async (context) => { const { base, compare } = await rankFixture(context); compare({ ...base, optionId: "a" }, { ...base, optionId: "z" }, 6); compare({ ...base, optionId: "z" }, base, 6); });
test("final ranking tie uses canonical plan data deterministically", async (context) => { const { base, compare, action } = await rankFixture(context); compare({ ...base, changes: [{ ...action, anchorEventId: "a" }] }, { ...base, changes: [{ ...action, anchorEventId: "z" }] }, 7); assert.deepEqual(firstRankingDifference(base, base, date("2025-08-31")), { criterion: null, comparison: 0 }); });
test("selected plan IDs and ordering are deterministic across repeated searches", async (context) => { const input = await prepare(context, monthly("reducible_or_stoppable"), flexible); const repeated = selectPlans(input.state, input.forecast, input.recurrence, input.data.fx, input.data.paymentOptions); assert.equal(repeated.selected?.id, input.selection.selected?.id); assert.deepEqual(repeated.rankingTrace, input.selection.rankingTrace); });
