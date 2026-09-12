import { createHash } from "node:crypto";
import { DateOnly } from "../core/dates.js";
import { Money } from "../core/money.js";
import { recurrencePolicy } from "../config.js";
import type {
  AmountEstimator, FinancialState, RationalAmount, RecurrenceExclusion, RecurrenceObservation,
  RecurrencePolicy, RecurrenceResult, RecurrenceSchedule, RecurrenceSeries,
} from "../domain.js";

const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const chronological = (a: RecurrenceObservation, b: RecurrenceObservation): number => a.date.compare(b.date) || lexical(a.eventId, b.eventId);
function gcd(a: bigint, b: bigint): bigint { while (b !== 0n) { const next = a % b; a = b; b = next; } return a < 0n ? -a : a; }

/** Exact rational arithmetic for non-terminating means and calibration metrics. */
export class ExactRatio {
  readonly numerator: bigint;
  readonly denominator: bigint;
  constructor(numerator: bigint, denominator = 1n) {
    if (denominator <= 0n) throw new Error("Rational denominator must be positive");
    const divisor = gcd(numerator, denominator);
    this.numerator = numerator / divisor; this.denominator = denominator / divisor;
    Object.freeze(this);
  }
  static fromDecimalString(text: string): ExactRatio {
    if (!/^-?\d+(?:\.\d+)?$/.test(text)) throw new Error("Invalid exact decimal");
    const negative = text.startsWith("-");
    const [integer = "0", fraction = ""] = text.replace("-", "").split(".");
    return new ExactRatio(BigInt(integer + fraction) * (negative ? -1n : 1n), 10n ** BigInt(fraction.length));
  }
  static fromAmount(amount: RationalAmount): ExactRatio { return new ExactRatio(BigInt(amount.numerator), BigInt(amount.denominator)); }
  add(other: ExactRatio): ExactRatio { return new ExactRatio(this.numerator * other.denominator + other.numerator * this.denominator, this.denominator * other.denominator); }
  subtract(other: ExactRatio): ExactRatio { return this.add(new ExactRatio(-other.numerator, other.denominator)); }
  multiply(other: ExactRatio): ExactRatio { return new ExactRatio(this.numerator * other.numerator, this.denominator * other.denominator); }
  divide(other: ExactRatio): ExactRatio {
    if (other.numerator <= 0n) throw new Error("Divisor must be positive");
    return new ExactRatio(this.numerator * other.denominator, this.denominator * other.numerator);
  }
  compare(other: ExactRatio): -1 | 0 | 1 { const delta = this.numerator * other.denominator - other.numerator * this.denominator; return delta < 0n ? -1 : delta > 0n ? 1 : 0; }
  abs(): ExactRatio { return new ExactRatio(this.numerator < 0n ? -this.numerator : this.numerator, this.denominator); }
  toFractionString(): string { return this.denominator === 1n ? this.numerator.toString() : this.numerator + "/" + this.denominator; }
  /** Rounded down only for presentation; decisions compare exact fractions. */
  toDisplayDecimal(scale = 6): string {
    if (!Number.isSafeInteger(scale) || scale < 0 || scale > 12) throw new Error("Invalid display scale");
    const factor = 10n ** BigInt(scale);
    const scaled = this.numerator * factor;
    const value = scaled / this.denominator - (scaled < 0n && scaled % this.denominator !== 0n ? 1n : 0n);
    const text = (value < 0n ? -value : value).toString().padStart(scale + 1, "0");
    return (value < 0n ? "-" : "") + (scale === 0 ? text : text.slice(0, -scale) + "." + text.slice(-scale));
  }
}

export function policyHash(policy: RecurrencePolicy): string {
  return createHash("sha256").update(JSON.stringify(Object.entries(policy).sort(([a], [b]) => lexical(a, b)))).digest("hex");
}
export function normalizeDescription(description: string): string {
  // Preserve digits, currency symbols, slashes, hyphens and plus signs; no fuzzy matching.
  return description.toLowerCase().replace(/[.,;:!?()[\]"]/g, " ").replace(/\s+/g, " ").trim();
}
const irregularPurpose = /\b(bonus|bonuses|commission|commissions|reimbursement|reimbursements|windfall|lottery|jackpot|arrears|gift|gifts)\b/;
const uncertainIncome = /\b(seasonal|season|temporary|terminated|ended|previous|former|leave|milestone|project|invoice)\b/;

/** Prefix eligibility is recalculated at the cutoff; later lifecycle links cannot censor earlier training. */
export function eligibleHistorical(state: FinancialState, historicalCutoff?: DateOnly): {
  observations: readonly RecurrenceObservation[]; exclusions: readonly RecurrenceExclusion[];
} {
  const cutoff = historicalCutoff ?? state.request.date;
  if (cutoff.compare(state.request.date) > 0) throw new Error("Cutoff cannot exceed request date");
  // At request inspection all supplied lifecycle uncertainty is known, including pending links.
  // Historical origins know only records posted before their own cutoff, not later settlements.
  const known = new Set(state.records.filter((record) => historicalCutoff === undefined || record.event.eventDate.compare(cutoff) < 0).map((record) => record.event.id));
  const visibleEdges = state.lifecycleGroups.flatMap((group) => group.edges).filter((edge) => known.has(edge.earlierEventId) && known.has(edge.laterEventId));
  const ambiguous = new Set(visibleEdges.filter((edge) => edge.kind === "ambiguous").flatMap((edge) => [edge.earlierEventId, edge.laterEventId]));
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const edge of visibleEdges) if (ambiguous.has(edge.earlierEventId) || ambiguous.has(edge.laterEventId)) {
      for (const id of [edge.earlierEventId, edge.laterEventId]) if (!ambiguous.has(id)) { ambiguous.add(id); expanded = true; }
    }
  }
  const observations: RecurrenceObservation[] = [];
  const exclusions: RecurrenceExclusion[] = [];
  for (const record of state.records) {
    const event = record.event;
    // An origin cannot inspect even exclusion metadata from records not yet posted.
    if (historicalCutoff !== undefined && event.eventDate.compare(cutoff) >= 0) continue;
    const reasons: string[] = [];
    if (record.category !== "historical_settled" || event.status !== "settled" || event.settlementDate === null ||
      event.settlementDate.compare(cutoff) >= 0 || event.eventDate.compare(cutoff) >= 0) reasons.push("not_prior_settled_cash");
    if (event.amount.kind !== "resolved") reasons.push("unresolved_amount");
    if (record.conversion === null || record.cashFact === null) reasons.push("unresolved_cash_or_fx");
    if (ambiguous.has(event.id)) reasons.push("ambiguous_lifecycle");
    if (record.unresolvedReasons.some((reason) => reason !== "ambiguous_lifecycle")) reasons.push("unresolved_meaning");
    if (event.type === "refund") reasons.push("refund");
    if (event.type.startsWith("investment_")) reasons.push("investment");
    const purpose = normalizeDescription(event.raw.category + " " + event.raw.description).replaceAll("_", " ");
    if (irregularPurpose.test(purpose)) reasons.push("irregular_or_one_time_purpose");
    if (/\b(internal|self|own)\b.*\btransfer\b|\btransfer\b.*\b(internal|self|own)\b/.test(purpose)) reasons.push("internal_transfer_unestablished");
    if (event.direction === "credit" && (/\btransfer\b/.test(purpose) || event.type !== "income")) reasons.push("unestablished_income");
    if (event.direction === "non_cash") reasons.push("non_cash");
    if (reasons.length > 0) { exclusions.push(Object.freeze({ eventId: event.id, reasons: Object.freeze(reasons), source: event.source })); continue; }
    if (event.amount.kind !== "resolved" || event.settlementDate === null || event.direction === "non_cash") throw new Error("Eligibility invariant failed");
    observations.push(Object.freeze({
      eventId: event.id, userId: event.userId, direction: event.direction, eventType: event.type,
      category: event.raw.category, description: normalizeDescription(event.raw.description), flexibility: event.raw.flexibility,
      amount: event.amount.money, date: event.settlementDate, source: event.source,
    }));
  }
  return { observations: Object.freeze(observations.sort(chronological)), exclusions: Object.freeze(exclusions.sort((a, b) => lexical(a.eventId, b.eventId))) };
}

const monthIndex = (date: DateOnly): number => { const { year, month } = date.calendarParts(); return year * 12 + month; };
const unsupported = (gaps: readonly number[]): RecurrenceSchedule => Object.freeze({
  kind: "unsupported", anchorDay: null, monthEnd: false, intervalDays: null,
  deviations: Object.freeze([...gaps]), matchedGaps: 0, totalGaps: gaps.length,
});
function enoughMatches(matches: number, total: number, income: boolean): boolean {
  return total > 0 && (income ? matches === total : matches * 5 >= total * 4);
}
export function detectSchedule(observations: readonly RecurrenceObservation[], policy: RecurrencePolicy): RecurrenceSchedule {
  const sorted = [...observations].sort(chronological);
  const gaps = sorted.slice(1).map((observation, index) => observation.date.differenceInDays(sorted[index]!.date));
  if (sorted.length < 2 || gaps.some((gap) => gap <= 0)) return unsupported(gaps);
  const income = sorted[0]!.direction === "credit";
  const monthlyGaps = sorted.slice(1).map((observation, index) => monthIndex(observation.date) - monthIndex(sorted[index]!.date));
  const monthlyCandidates: RecurrenceSchedule[] = [];
  // Original anchor is fitted across observations, not repeatedly clipped from the previous month.
  const plausibleAnchors = new Set<number>();
  if (enoughMatches(monthlyGaps.filter((gap) => gap === 1).length, gaps.length, income)) {
    for (const observation of sorted) {
      const day = observation.date.calendarParts().day;
      for (let offset = -policy.dateToleranceDays; offset <= policy.dateToleranceDays; offset++) if (day + offset >= 1 && day + offset <= 31) plausibleAnchors.add(day + offset);
      // A clipped month end can support an intended anchor up to 31.
      if (observation.date.isMonthEnd()) for (let anchor = day; anchor <= 31; anchor++) plausibleAnchors.add(anchor);
    }
  }
  for (const anchor of plausibleAnchors) {
    const deviations = sorted.map((observation) => observation.date.differenceInDays(observation.date.addCalendarMonths(0, anchor)));
    const matches = monthlyGaps.filter((gap, index) => gap === 1 && Math.abs(deviations[index]!) <= policy.dateToleranceDays && Math.abs(deviations[index + 1]!) <= policy.dateToleranceDays).length;
    if (enoughMatches(matches, gaps.length, income)) monthlyCandidates.push(Object.freeze({
      kind: "calendar_monthly", anchorDay: anchor, monthEnd: sorted.every((observation) => observation.date.isMonthEnd()), intervalDays: null,
      deviations: Object.freeze(deviations), matchedGaps: matches, totalGaps: gaps.length,
    }));
  }
  monthlyCandidates.sort((a, b) => b.matchedGaps - a.matchedGaps ||
    a.deviations.reduce((sum, value) => sum + Math.abs(value), 0) - b.deviations.reduce((sum, value) => sum + Math.abs(value), 0) || (b.anchorDay! - a.anchorDay!));
  const fixedCandidates: RecurrenceSchedule[] = [];
  for (const interval of [...new Set(gaps)].sort((a, b) => a - b)) {
    const deviations = gaps.map((gap) => gap - interval);
    const matches = deviations.filter((deviation) => Math.abs(deviation) <= policy.dateToleranceDays).length;
    if (enoughMatches(matches, gaps.length, income)) fixedCandidates.push(Object.freeze({
      kind: "fixed_interval_days", anchorDay: null, monthEnd: false, intervalDays: interval,
      deviations: Object.freeze(deviations), matchedGaps: matches, totalGaps: gaps.length,
    }));
  }
  fixedCandidates.sort((a, b) => b.matchedGaps - a.matchedGaps ||
    a.deviations.reduce((sum, value) => sum + Math.abs(value), 0) - b.deviations.reduce((sum, value) => sum + Math.abs(value), 0) || a.intervalDays! - b.intervalDays!);
  return policy.schedulePreference === "calendar_first" ? monthlyCandidates[0] ?? fixedCandidates[0] ?? unsupported(gaps) : fixedCandidates[0] ?? monthlyCandidates[0] ?? unsupported(gaps);
}

function baseProperties(observation: RecurrenceObservation): readonly string[] {
  return [observation.userId, observation.direction, observation.eventType, observation.category, observation.amount.currency, observation.flexibility];
}
export function observationMatches(signature: string, observation: RecurrenceObservation): boolean {
  const parsed = JSON.parse(signature) as { base: string[]; description: string | null; excludedDescriptions?: string[] };
  return JSON.stringify(parsed.base) === JSON.stringify(baseProperties(observation)) && (parsed.description === null || parsed.description === observation.description) &&
    !parsed.excludedDescriptions?.includes(observation.description);
}
const variableCategories = new Set(["groceries", "transport", "dining", "utilities", "healthcare", "shopping", "entertainment"]);
export function groupObservations(observations: readonly RecurrenceObservation[], policy: RecurrencePolicy): ReadonlyMap<string, readonly RecurrenceObservation[]> {
  const bases = new Map<string, RecurrenceObservation[]>();
  for (const observation of [...observations].sort(chronological)) {
    const key = JSON.stringify(baseProperties(observation)); const bucket = bases.get(key) ?? []; bucket.push(observation); bases.set(key, bucket);
  }
  const groups = new Map<string, readonly RecurrenceObservation[]>();
  for (const [base, stream] of [...bases].sort(([a], [b]) => lexical(a, b))) {
    const descriptions = new Map<string, RecurrenceObservation[]>();
    for (const observation of stream) { const bucket = descriptions.get(observation.description) ?? []; bucket.push(observation); descriptions.set(observation.description, bucket); }
    const pooled: RecurrenceObservation[] = [];
    const separatedDescriptions: string[] = [];
    for (const [description, members] of [...descriptions].sort(([a], [b]) => lexical(a, b))) {
      const first = members[0]!;
      const fixed = members.length >= 3 && members.every((member) => member.amount.equals(first.amount)) && detectSchedule(members, policy).kind !== "unsupported";
      const purposePool = first.direction === "debit" && first.eventType === "expense" && variableCategories.has(first.category);
      // Separate demonstrably fixed bills before pooling a variable category stream.
      const pool = policy.grouping !== "description" && purposePool && !fixed &&
        (policy.grouping === "category" || detectSchedule(members, policy).kind === "unsupported" || ["groceries", "transport", "dining"].includes(first.category));
      if (pool) pooled.push(...members);
      else { groups.set(JSON.stringify({ base: JSON.parse(base) as string[], description }), Object.freeze(members)); separatedDescriptions.push(description); }
    }
    if (pooled.length > 0) groups.set(JSON.stringify({ base: JSON.parse(base) as string[], description: null, excludedDescriptions: separatedDescriptions }), Object.freeze(pooled.sort(chronological)));
  }
  return new Map([...groups].sort(([a], [b]) => lexical(a, b)));
}

export function estimateAmount(observations: readonly RecurrenceObservation[], estimator: AmountEstimator, window: number): RationalAmount {
  if (observations.length === 0 || !Number.isSafeInteger(window) || window < 2) throw new Error("Amount estimator requires observations and a valid window");
  const ordered = [...observations].sort(chronological);
  const selected = estimator === "recent_median" ? ordered.slice(-window) : ordered;
  const values = selected.map((observation) => observation.amount).sort((a, b) => a.compare(b));
  const currency = values[0]!.currency;
  if (values.some((value) => value.currency !== currency)) throw new Error("Amount model cannot mix currencies");
  let result: ExactRatio;
  const exact = (money: Money): ExactRatio => ExactRatio.fromDecimalString(money.toExactDecimalString());
  if (estimator === "mean") result = exact(values.reduce((sum, value) => sum.add(value), Money.fromDecimalString("0", currency))).divide(new ExactRatio(BigInt(values.length)));
  else if (estimator === "median" || estimator === "recent_median") {
    const middle = Math.floor(values.length / 2);
    result = values.length % 2 === 1 ? exact(values[middle]!) : exact(values[middle - 1]!).add(exact(values[middle]!)).divide(new ExactRatio(2n));
  } else if (estimator === "last") result = exact(ordered.at(-1)!.amount);
  else {
    const index = estimator === "maximum" ? values.length - 1 : estimator === "minimum" ? 0 :
      Math.max(0, Number((BigInt(values.length) * (estimator === "upper_quantile" ? 4n : 1n) + 4n) / 5n) - 1);
    result = exact(values[index]!);
  }
  return Object.freeze({ numerator: result.numerator.toString(), denominator: result.denominator.toString(), currency });
}

function nextDate(last: DateOnly, schedule: RecurrenceSchedule): DateOnly | null {
  return schedule.kind === "calendar_monthly" ? last.addCalendarMonths(1, schedule.anchorDay!, schedule.monthEnd) :
    schedule.kind === "fixed_interval_days" ? last.addDays(schedule.intervalDays!) : null;
}
export function detectSeries(
  observations: readonly RecurrenceObservation[], asOf: DateOnly, policy: RecurrencePolicy = recurrencePolicy,
  futureObservations: readonly RecurrenceObservation[] = [],
): readonly RecurrenceSeries[] {
  if (observations.some((observation) => observation.date.compare(asOf) >= 0)) throw new Error("Training must precede cutoff");
  const series: RecurrenceSeries[] = [];
  for (const [signature, members] of groupObservations(observations, policy)) {
    const first = members[0]!; const last = members.at(-1)!;
    const income = first.direction === "credit";
    const threshold = income ? Math.max(5, policy.minimumIncomeObservations) : Math.max(3, policy.minimumExpenseObservations);
    const fullSchedule = detectSchedule(members, policy);
    const recent = members.slice(-policy.recentWindow);
    const recentSchedule = detectSchedule(recent, policy);
    const regimeChanged = fullSchedule.kind === "unsupported" && recentSchedule.kind !== "unsupported";
    const schedule = regimeChanged ? recentSchedule : fullSchedule;
    const allFixed = members.every((member) => member.amount.equals(first.amount));
    const min = members.reduce((value, member) => value.minimum(member.amount), first.amount);
    const max = members.reduce((value, member) => value.maximum(member.amount), first.amount);
    const stable = ExactRatio.fromDecimalString(max.subtract(min).toExactDecimalString()).multiply(new ExactRatio(BigInt(policy.fixedToleranceDenominator)))
      .compare(ExactRatio.fromDecimalString(max.toExactDecimalString()).multiply(new ExactRatio(BigInt(policy.fixedToleranceNumerator)))) <= 0;
    const amountModel = allFixed ? "fixed" : income ? policy.incomeEstimator : policy.expenseEstimator;
    const estimatedAmount = estimateAmount(members, amountModel === "fixed" ? "last" : amountModel, policy.recentWindow);
    let expectedNextOccurrence = nextDate(last.date, schedule);
    let missedOccurrences = 0;
    if (expectedNextOccurrence !== null && expectedNextOccurrence.addDays(policy.dateToleranceDays).compare(asOf) < 0) {
      if (schedule.kind === "fixed_interval_days") missedOccurrences = Math.ceil((asOf.differenceInDays(expectedNextOccurrence) - policy.dateToleranceDays) / schedule.intervalDays!);
      else {
        missedOccurrences = Math.max(0, monthIndex(asOf) - monthIndex(expectedNextOccurrence));
        const advanced = expectedNextOccurrence.addCalendarMonths(missedOccurrences, schedule.anchorDay!, schedule.monthEnd);
        if (advanced.addDays(policy.dateToleranceDays).compare(asOf) < 0) missedOccurrences++;
      }
    }
    const future = futureObservations.filter((observation) => observation.date.compare(asOf) >= 0 && observationMatches(signature, observation));
    const diagnostics: string[] = [];
    let support: RecurrenceSeries["support"] = members.length < threshold ? "low" : schedule.kind === "unsupported" ? "unsupported" : income ? "strong" : "supported";
    let status: RecurrenceSeries["status"] = "active";
    if (members.length < threshold || schedule.kind === "unsupported") { status = "ambiguous"; diagnostics.push("insufficient_schedule_support"); }
    if (schedule.deviations.some((deviation) => deviation !== 0)) diagnostics.push("observed_date_deviations");
    if (regimeChanged) {
      diagnostics.push("recent_cadence_regime_change");
      if (recent.length < threshold || income) { status = "ambiguous"; support = "low"; }
    }
    if (!allFixed && recent.length >= 3 && recent.every((member) => member.amount.equals(last.amount)) && !last.amount.equals(first.amount)) diagnostics.push("recent_amount_regime_change");
    if (income && uncertainIncome.test(first.description.replaceAll("_", " "))) { status = "ambiguous"; support = "low"; diagnostics.push("income_source_continuity_uncertain"); }
    if (missedOccurrences > 0) {
      diagnostics.push("missed_expected_occurrences:" + missedOccurrences);
      const allowance = income ? policy.incomeMissedAllowance : policy.expenseMissedAllowance;
      status = missedOccurrences > allowance ? "inactive" : "ambiguous";
      if (!income && future.length > 0 && members.length >= threshold && schedule.kind !== "unsupported") { status = "ambiguous"; diagnostics.push("supplied_future_obligation_separate"); }
    }
    // Inactive/ambiguous income never supplies a diagnostic future-income date.
    if (income && (status !== "active" || support !== "strong")) expectedNextOccurrence = null;
    if (status === "inactive") expectedNextOccurrence = null;
    if (!income && status !== "active") diagnostics.push("expense_continuity_requires_review_not_cancellation");
    const identity = JSON.stringify(["recurrence", policy.grouping, signature, schedule.kind, schedule.anchorDay, schedule.monthEnd, schedule.intervalDays]);
    series.push(Object.freeze({
      id: "series-" + createHash("sha256").update(identity).digest("hex"), userId: first.userId, direction: first.direction,
      eventType: first.eventType, category: first.category, currency: first.amount.currency, groupingPolicy: policy.grouping, matchingSignature: signature,
      supportingEventIds: Object.freeze(members.map((member) => member.eventId)), provenance: Object.freeze(members.map((member) => member.source)),
      firstObservedDate: first.date, lastObservedDate: last.date, observationCount: members.length,
      schedule, amountModel, amountBehavior: allFixed ? "fixed" : stable ? "stable_with_variation" : "variable", estimatedAmount,
      referenceAmount: estimateAmount(members, allFixed ? "last" : "recent_median", policy.recentWindow),
      referenceAmountUse: "diagnostic_only", activityPolicy: "provisional",
      activityConfidence: status === "active" ? "cadence_only" : "uncertain",
      incomeInferenceEligible: income && status === "active" && support === "strong",
      expenseContinuity: income ? null : status === "active" ? "supported" : "must_review",
      expectedNextOccurrence, status, support, missedOccurrences, regimeChanged,
      suppliedFutureEventIds: Object.freeze(future.map((observation) => observation.eventId).sort(lexical)), diagnostics: Object.freeze(diagnostics),
    }));
  }
  return Object.freeze(series.sort((a, b) => lexical(a.id, b.id)));
}

export function analyzeRecurrence(state: FinancialState, policy: RecurrencePolicy = recurrencePolicy): RecurrenceResult {
  const eligible = eligibleHistorical(state);
  const future: RecurrenceObservation[] = state.records.filter((record) => record.category === "confirmed_future" &&
    record.event.amount.kind === "resolved" && record.unresolvedReasons.length === 0 && record.event.settlementDate !== null)
    .map((record) => {
      const event = record.event;
      if (event.amount.kind !== "resolved" || event.settlementDate === null || event.direction === "non_cash") throw new Error("Future reference invariant failed");
      return { eventId: event.id, userId: event.userId, direction: event.direction, eventType: event.type, category: event.raw.category,
        description: normalizeDescription(event.raw.description), flexibility: event.raw.flexibility, amount: event.amount.money, date: event.settlementDate, source: event.source };
    });
  return Object.freeze({ policyVersion: policy.version, policyHash: policyHash(policy), ...eligible,
    series: detectSeries(eligible.observations, state.request.date, policy, future) });
}
