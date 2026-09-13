import { createHash } from "node:crypto";
import { forecastPolicy, planPolicy, sortIssues } from "../config.js";
import { Money } from "../core/money.js";
import type { FxIndex } from "../core/fx.js";
import type { DateOnly } from "../core/dates.js";
import type { BaselineCapacity, CanonicalPaymentOption, DatedPayment, FinancialForecast, FinancialState, InternalPaymentPlan, PlanIssue, PlanMethod, PlanSelection, PlanValidation, RecurrenceResult, RejectedPlanCandidate, SpendingAction } from "../domain.js";
import { calculateCapacity } from "./capacity.js";
import { expandOption, planIssue } from "./options.js";
import { actionSets, actionText, applySpending, availableActions } from "./spending.js";
import { simulate } from "./simulate.js";

const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function canonicalPlan(plan: Omit<InternalPaymentPlan, "id" | "provenance">): string {
  return JSON.stringify({ request: plan.requestId, method: plan.method, option: plan.optionId,
    payments: plan.payments.map((payment) => [payment.date.toISODateString(), payment.amount.toExactDecimalString(), payment.amount.currency]),
    fee: plan.financingFee.toExactDecimalString(), total: plan.totalPaid.toExactDecimalString(),
    changes: [...plan.changes].sort((a, b) => lexical(actionText(a), actionText(b))).map((change) => [actionText(change), change.seriesId, change.amount?.currency ?? null]) });
}
export function createPlan(state: FinancialState, method: PlanMethod, payments: readonly DatedPayment[], changes: readonly SpendingAction[] = [], option: CanonicalPaymentOption | null = null): InternalPaymentPlan {
  const value = { requestId: state.request.id, method, optionId: option?.id ?? null, payments: Object.freeze(payments.map((payment) => Object.freeze({ ...payment }))),
    financingFee: option?.financingFee ?? Money.fromDecimalString("0", state.profile.homeCurrency),
    totalPaid: payments.reduce((sum, payment) => sum.add(payment.amount), Money.fromDecimalString("0", state.profile.homeCurrency)),
    changes: Object.freeze([...changes].sort((a, b) => lexical(actionText(a), actionText(b)))) };
  return Object.freeze({ ...value, id: "plan-" + createHash("sha256").update(canonicalPlan(value)).digest("hex"),
    provenance: Object.freeze([state.request.source, ...(option ? [option.source] : []), ...changes.flatMap((change) => change.provenance)]) });
}
const sameSchedule = (a: readonly DatedPayment[], b: readonly DatedPayment[]): boolean => a.length === b.length && a.every((payment, index) => payment.date.equals(b[index]!.date) && payment.amount.currency === b[index]!.amount.currency && payment.amount.equals(b[index]!.amount));
const accepts = (state: FinancialState, method: PlanMethod): boolean => state.profile.raw.payment_methods_user_will_consider.split("|").includes(method === "wait" ? "full_payment" : method);

export function validatePlan(state: FinancialState, forecast: FinancialForecast, baseline: BaselineCapacity, plan: InternalPaymentPlan,
  recurrence: RecurrenceResult, fx: FxIndex, options: readonly CanonicalPaymentOption[]): PlanValidation {
  const issues: PlanIssue[] = [];
  const reject = (code: string, stage: PlanIssue["stage"], explanation: string, field = "payment_plan"): void => { issues.push(planIssue(code, stage, state.request.source, explanation, field, plan.id, plan.optionId)); };
  if (baseline.status === "blocked" || forecast.issues.some((issue) => issue.severity === "error")) reject("PLAN_BLOCKED_INPUT", "input", "Blocking financial input cannot become safe through payment generation");
  if (baseline.status === "conservative_unresolved" || forecast.issues.some((issue) => issue.effect === "conservative_unresolved")) reject("PLAN_UNRESOLVED_LIABILITY", "input", "Conservative unresolved liabilities cannot establish plan safety");
  if (forecast.policyUsage !== "production" || forecast.policyVersion !== forecastPolicy.version || forecast.end.differenceInDays(forecast.start) !== forecastPolicy.horizonDays || baseline.baselineTraces.some((trace) => trace.requestId !== state.request.id || trace.forecastPolicyHash !== forecast.policyHash)) reject("PLAN_BASELINE_MISMATCH", "input", "Plan must use this request's production baseline and horizon");
  if (plan.requestId !== state.request.id) reject("PLAN_REQUEST", "eligibility", "Plan belongs to a different request");
  if (!["full_payment", "wait", "partial_payment", "installments"].includes(plan.method) || !accepts(state, plan.method)) reject("PLAN_PREFERENCE", "eligibility", "User does not accept the payment method");
  const zero = Money.fromDecimalString("0", state.profile.homeCurrency);
  if (plan.payments.length === 0) reject("PLAN_EMPTY", "eligibility", "Complete payment schedule is required");
  for (const [index, payment] of plan.payments.entries()) {
    if (payment.amount.currency !== zero.currency || payment.amount.compare(zero) <= 0) reject("PLAN_PAYMENT_AMOUNT", "eligibility", "Each payment must be positive in home currency");
    if (payment.date.compare(forecast.start) < 0 || payment.date.compare(forecast.end) > 0) reject("PLAN_HORIZON", "eligibility", "Payment lies outside forecast horizon");
    if (payment.date.compare(state.request.deadline) > 0) reject("PLAN_DEADLINE", "eligibility", "Payment completes after desired completion date");
    if (index > 0 && payment.date.compare(plan.payments[index - 1]!.date) <= 0) reject("PLAN_CHRONOLOGY", "eligibility", "Multiple payments must be strictly chronological");
  }
  if ([plan.totalPaid, plan.financingFee, ...plan.payments.map((payment) => payment.amount)].some((amount) => amount.currency !== zero.currency)) reject("PLAN_CURRENCY", "eligibility", "Plan currency differs from home currency");
  else {
    const paid = plan.payments.reduce((sum, payment) => sum.add(payment.amount), zero);
    if (!paid.equals(plan.totalPaid) || !paid.equals(state.request.amount.add(plan.financingFee)) || plan.financingFee.compare(zero) < 0) reject("PLAN_COMPLETE_TOTAL", "eligibility", "Complete principal plus valid fee must be paid exactly");
  }
  const expected: DatedPayment[] = [];
  if (plan.method === "installments") {
    const matches = options.filter((option) => option.id === plan.optionId && option.requestId === state.request.id && option.method === "installments");
    if (matches.length !== 1) reject("PLAN_OPTION_REQUIRED", "eligibility", "Installments require one existing supplied option");
    else {
      const option = matches[0]!, expanded = expandOption(state, forecast, option); issues.push(...expanded.issues.map((issue) => Object.freeze({ ...issue, candidateId: plan.id })));
      if (expanded.payments && (!sameSchedule(plan.payments, expanded.payments) || plan.financingFee.currency !== option.financingFee.currency || plan.totalPaid.currency !== option.totalPayableAmount.currency || !plan.financingFee.equals(option.financingFee) || !plan.totalPaid.equals(option.totalPayableAmount))) reject("PLAN_OPTION_TERMS", "eligibility", "Schedule, fees and total must exactly match supplied option");
    }
  } else {
    if (plan.optionId !== null || !plan.financingFee.isZero()) reject("PLAN_UNSUPPORTED_TERMS", "eligibility", "Synthetic full/wait/partial candidates cannot invent option fees");
    if (plan.method === "full_payment") expected.push({ date: state.request.date, amount: state.request.amount });
    if (plan.method === "wait") {
      if (baseline.status !== "valid" || baseline.earliestFullPaymentDate === null || baseline.earliestFullPaymentDate.compare(state.request.date) <= 0) reject("PLAN_WAIT_BASELINE", "eligibility", "Wait requires a known later full-payment date on a valid baseline");
      else expected.push({ date: baseline.earliestFullPaymentDate, amount: state.request.amount });
    }
    if (plan.method === "partial_payment") {
      const safe = baseline.maximumImmediatePayment?.minimum(state.request.amount) ?? null;
      if (!state.request.raw.allows_partial_payment) reject("PLAN_PARTIAL_PERMISSION", "eligibility", "Request does not allow partial payment");
      if (baseline.status !== "valid" || safe === null || safe.compare(zero) <= 0 || safe.compare(state.request.amount) >= 0 || baseline.earliestFullPaymentDate === null) reject("PLAN_PARTIAL_BASELINE", "eligibility", "Partial payment requires positive incomplete baseline capacity and a full-payment date");
      else expected.push({ date: state.request.date, amount: safe }, { date: baseline.earliestFullPaymentDate, amount: state.request.amount.subtract(safe) });
    }
    if (expected.length > 0 && !sameSchedule(plan.payments, expected)) reject("PLAN_REQUIRED_SCHEDULE", "eligibility", "Schedule differs from exact method-specific baseline rule");
  }
  const changed = applySpending(state, forecast, recurrence, plan.changes, fx); issues.push(...changed.issues.map((issue) => Object.freeze({ ...issue, candidateId: plan.id })));
  const scenarios: PlanValidation["scenarios"][number][] = [];
  if (issues.length === 0) {
    const pending = state.pendingBalancePolicy === "unknown" ? forecastPolicy.pendingScenarios : [state.pendingBalancePolicy];
    for (const hypothesis of pending) for (const ordering of forecastPolicy.sameDayScenarios) {
      const trace = simulate(state, changed.forecast, hypothesis, ordering, plan.payments.map((payment, index) => ({ id: plan.id + ":" + index, date: payment.date, amount: payment.amount.negate(), source: state.request.source })));
      const safe = trace.breaches.length === 0 && trace.issues.length === 0;
      scenarios.push(Object.freeze({ pending: hypothesis, ordering, safe, minimum: trace.minimumBalance, breaches: trace.breaches }));
      for (const issue of trace.issues) reject("PLAN_" + issue.code, "input", issue.explanation);
      if (trace.breaches.length > 0) reject("PLAN_MINIMUM_BREACH", "safety", "Complete schedule breaches required minimum under " + hypothesis + "/" + ordering);
    }
  }
  return Object.freeze({ valid: issues.length === 0 && scenarios.length > 0 && scenarios.every((scenario) => scenario.safe), issues: sortIssues(issues) as readonly PlanIssue[], scenarios: Object.freeze(scenarios), changedMovementIds: changed.changedMovementIds });
}

export function rankingKeys(plan: InternalPaymentPlan, deadline: DateOnly): readonly (string | number | boolean | null)[] {
  return Object.freeze([plan.payments.at(-1)!.date.compare(deadline) <= 0, plan.changes.length > 0, plan.totalPaid.toExactDecimalString(), plan.payments[0]!.date.toISODateString(), plan.payments.length, plan.optionId, canonicalPlan(plan)]);
}
export function firstRankingDifference(a: InternalPaymentPlan, b: InternalPaymentPlan, deadline: DateOnly): { readonly criterion: number | null; readonly comparison: number } {
  const order = [Number(a.payments.at(-1)!.date.compare(deadline) > 0) - Number(b.payments.at(-1)!.date.compare(deadline) > 0),
    Number(a.changes.length > 0) - Number(b.changes.length > 0), a.totalPaid.compare(b.totalPaid), a.payments[0]!.date.compare(b.payments[0]!.date), a.payments.length - b.payments.length,
    a.optionId === b.optionId ? 0 : a.optionId === null ? 1 : b.optionId === null ? -1 : lexical(a.optionId, b.optionId), lexical(canonicalPlan(a), canonicalPlan(b))];
  const index = order.findIndex((value) => value !== 0); return { criterion: index < 0 ? null : index + 1, comparison: index < 0 ? 0 : order[index]! };
}

export function selectPlans(state: FinancialState, forecast: FinancialForecast, recurrence: RecurrenceResult, fx: FxIndex, options: readonly CanonicalPaymentOption[]): PlanSelection {
  const baseline = calculateCapacity(state, forecast), safe = baseline.maximumImmediatePayment?.minimum(state.request.amount) ?? null;
  const eligible: InternalPaymentPlan[] = [], valid: { plan: InternalPaymentPlan; validation: PlanValidation }[] = [], rejected: RejectedPlanCandidate[] = [];
  const pool = availableActions(state, forecast, recurrence), sets = actionSets(pool.actions), optionIssues: PlanIssue[] = [];
  const installments: { option: CanonicalPaymentOption; payments: readonly DatedPayment[] }[] = [];
  for (const option of [...options].sort((a, b) => lexical(a.id, b.id))) {
    const expanded = expandOption(state, forecast, option); optionIssues.push(...expanded.issues);
    if (option.method === "installments") {
      if (expanded.payments) installments.push({ option, payments: expanded.payments });
      else rejected.push({ plan: null, method: "installments", optionId: option.id, issues: expanded.issues });
    }
  }
  const skip = (method: PlanMethod, code: string, explanation: string): void => { rejected.push(Object.freeze({ plan: null, method, optionId: null, issues: Object.freeze([planIssue(code, "eligibility", state.request.source, explanation, "payment_method")]) })); };
  const attempt = (method: PlanMethod, payments: readonly DatedPayment[], changes: readonly SpendingAction[], option: CanonicalPaymentOption | null = null): void => {
    const plan = createPlan(state, method, payments, changes, option), validation = validatePlan(state, forecast, baseline, plan, recurrence, fx, options);
    if (!validation.issues.some((issue) => issue.stage !== "safety")) eligible.push(plan);
    if (validation.valid) valid.push(Object.freeze({ plan, validation })); else rejected.push(Object.freeze({ plan, method, optionId: option?.id ?? null, issues: validation.issues, validation }));
  };
  for (const method of ["full_payment", "wait", "partial_payment", "installments"] as const) {
    if (!accepts(state, method)) { skip(method, "PLAN_PREFERENCE", "User rejects payment method"); continue; }
    if (state.request.date.compare(state.request.deadline) > 0) { skip(method, "PLAN_DEADLINE", "Request date is after completion deadline"); continue; }
    if (state.request.amount.isZero()) { skip(method, "PLAN_ZERO_REQUEST", "Positive requested principal is required for payment candidates"); continue; }
    if (baseline.status === "blocked" || baseline.status === "conservative_unresolved") { skip(method, baseline.status === "blocked" ? "PLAN_BLOCKED_INPUT" : "PLAN_UNRESOLVED_LIABILITY", "Baseline input cannot establish candidate safety"); continue; }
    if (method === "wait" && (baseline.status !== "valid" || baseline.earliestFullPaymentDate === null || baseline.earliestFullPaymentDate.compare(state.request.date) <= 0)) { skip(method, "PLAN_WAIT_BASELINE", "No eligible later baseline full-payment date"); continue; }
    if (method === "partial_payment" && (!state.request.raw.allows_partial_payment || baseline.status !== "valid" || safe === null || safe.isZero() || safe.compare(state.request.amount) >= 0 || baseline.earliestFullPaymentDate === null)) { skip(method, "PLAN_PARTIAL_BASELINE", "Partial permission, incomplete capacity and known full-payment date are required"); continue; }
    if (method === "installments" && installments.length === 0) { skip(method, "PLAN_OPTION_REQUIRED", "No structurally valid supplied installment option"); continue; }
    for (const changes of sets) {
      if (method === "full_payment") attempt(method, [{ date: state.request.date, amount: state.request.amount }], changes);
      if (method === "wait") attempt(method, [{ date: baseline.earliestFullPaymentDate!, amount: state.request.amount }], changes);
      if (method === "partial_payment") attempt(method, [{ date: state.request.date, amount: safe! }, { date: baseline.earliestFullPaymentDate!, amount: state.request.amount.subtract(safe!) }], changes);
      if (method === "installments") for (const option of installments) attempt(method, option.payments, changes, option.option);
    }
  }
  valid.sort((a, b) => firstRankingDifference(a.plan, b.plan, state.request.deadline).comparison);
  const reasons: PlanSelection["absenceReasons"][number][] = [];
  if (valid.length === 0) {
    if (baseline.status === "blocked") reasons.push("blocked_input");
    else if (baseline.status === "conservative_unresolved") reasons.push("conservative_unresolved_liability");
    else {
      if (eligible.length === 0) reasons.push("no_eligible_payment_method"); else reasons.push("no_safe_candidate");
      const codes = rejected.flatMap((value) => value.issues.map((issue) => issue.code));
      if (codes.some((code) => code.includes("DEADLINE"))) reasons.push("deadline");
      if (codes.includes("PLAN_PREFERENCE")) reasons.push("preference");
      if (optionIssues.length > 0 || codes.includes("PLAN_OPTION_REQUIRED")) reasons.push("invalid_option");
      if (state.request.amount.isZero()) reasons.push("zero_requested_amount");
    }
  }
  return Object.freeze({ baseline, baselineSafeToPay: safe, eligibleCandidates: Object.freeze(eligible), rejectedCandidates: Object.freeze(rejected), validCandidates: Object.freeze(valid), selected: valid[0]?.plan ?? null,
    rankingTrace: Object.freeze(valid.map((value, index) => Object.freeze({ planId: value.plan.id, keys: rankingKeys(value.plan, state.request.deadline), firstDifferenceFromNext: valid[index + 1] ? firstRankingDifference(value.plan, valid[index + 1]!.plan, state.request.deadline).criterion : null }))),
    absenceReasons: Object.freeze(reasons), spendingIssues: pool.issues, optionIssues: Object.freeze(optionIssues), search: Object.freeze({ eligibleActions: pool.actions.length, actionSets: sets.length, pruning: planPolicy.reductionSearch + "; no-effect-in-entire-horizon excluded; all compatible sets up to three retained" }) });
}
