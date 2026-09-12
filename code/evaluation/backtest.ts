import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { parseDatasetArgument, recurrencePolicy, productionFiles, projectRoot } from "../src/config.js";
import { loadProduction } from "../src/data/load.js";
import { buildIndexes } from "../src/data/indexes.js";
import { normalizeData } from "../src/data/normalize.js";
import { reconstructState } from "../src/finance/state.js";
import { analyzeRecurrence, detectSeries, eligibleHistorical, ExactRatio, observationMatches, policyHash } from "../src/finance/recurrence.js";
import type { Currency, FinancialState, RationalAmount, RecurrenceObservation, RecurrencePolicy, RecurrenceSeries } from "../src/domain.js";

const baselinePolicy: RecurrencePolicy = Object.freeze({
  ...recurrencePolicy, version: "recurrence-v1-hybrid-safe", grouping: "hybrid", minimumExpenseObservations: 3,
  minimumIncomeObservations: 5, dateToleranceDays: 0, recentWindow: 6, expenseMissedAllowance: 1, incomeMissedAllowance: 0,
  expenseEstimator: "upper_quantile", incomeEstimator: "lower_quantile", fixedToleranceNumerator: 1, fixedToleranceDenominator: 20, schedulePreference: "calendar_first",
});
// Registered before measuring data; no request-specific policies or expected answers.
export const candidatePolicies: readonly RecurrencePolicy[] = Object.freeze([
  { ...baselinePolicy, version: "description-last", grouping: "description", expenseEstimator: "last", incomeEstimator: "last" },
  { ...baselinePolicy, version: "category-mean", grouping: "category", expenseEstimator: "mean", incomeEstimator: "mean" },
  { ...baselinePolicy, version: "category-safe", grouping: "category" },
  { ...baselinePolicy, version: "hybrid-mean", expenseEstimator: "mean", incomeEstimator: "mean" },
  { ...baselinePolicy, version: "hybrid-last", expenseEstimator: "last", incomeEstimator: "last" },
  { ...baselinePolicy, version: "hybrid-median", expenseEstimator: "median", incomeEstimator: "median" },
  { ...baselinePolicy, version: "hybrid-recent-median", expenseEstimator: "recent_median", incomeEstimator: "recent_median" },
  { ...baselinePolicy, version: "recurrence-v1-hybrid-safe" },
  { ...baselinePolicy, version: "hybrid-extremes", expenseEstimator: "maximum", incomeEstimator: "minimum" },
  { ...baselinePolicy, version: "hybrid-strict-safe", minimumExpenseObservations: 4, minimumIncomeObservations: 6 },
  { ...baselinePolicy, version: "hybrid-tolerant-safe", dateToleranceDays: 1, recentWindow: 4, expenseMissedAllowance: 2 },
  { ...baselinePolicy, version: "hybrid-window3-safe", recentWindow: 3 },
  { ...baselinePolicy, version: "hybrid-fixed-first-safe", schedulePreference: "fixed_first" },
  { ...baselinePolicy, version: "hybrid-income-grace-safe", incomeMissedAllowance: 1 },
  { ...baselinePolicy, version: "hybrid-low-support-safe", minimumExpenseObservations: 2, minimumIncomeObservations: 4 },
  { ...baselinePolicy, version: "hybrid-amount-tolerance-zero", fixedToleranceNumerator: 0 },
].map((policy) => Object.freeze(policy as RecurrencePolicy)));

export interface WithheldPrediction {
  readonly key: string; readonly seriesId: string; readonly policyVersion: string;
  readonly trainingEventIds: readonly string[]; readonly trainingLastDate: string;
  readonly predictedDate: string; readonly amount: RationalAmount;
  readonly actualEventId: string; readonly actualDate: string; readonly actualAmount: string;
  readonly direction: "debit" | "credit"; readonly absoluteDayError: number; readonly signedDayError: number;
}
interface PredictionOrigin { readonly series: RecurrenceSeries; readonly target: RecurrenceObservation | null; readonly key: string }
/** Every origin uses a chronological prefix. Withheld rows are used only for matching/scoring. */
function rollingEvaluation(state: FinancialState, policy: RecurrencePolicy): { readonly origins: readonly PredictionOrigin[]; readonly eligibleEventIds: ReadonlySet<string> } {
  const originDates = state.records.filter((record) => record.category === "historical_settled" && record.event.settlementDate !== null)
    .map((record) => record.event.eventDate.compare(record.event.settlementDate!) > 0 ? record.event.eventDate : record.event.settlementDate!);
  const dates = [...new Set(originDates.map((date) => date.toISODateString()))].sort();
  const seen = new Set<string>();
  const eligibleEventIds = new Set<string>();
  const origins: { series: RecurrenceSeries; target: RecurrenceObservation | null; key: string }[] = [];
  for (const date of dates) {
    const last = originDates.find((candidate) => candidate.toISODateString() === date)!;
    const cutoff = last.addDays(1);
    if (cutoff.compare(state.request.date) > 0) continue;
    const prefix = eligibleHistorical(state, cutoff).observations;
    for (const observation of prefix) eligibleEventIds.add(observation.eventId);
    // Freeze withheld eligibility when the observation becomes available. A dispute
    // posted later cannot retrospectively censor a previously scored observation.
    for (const origin of origins) if (origin.target === null) {
      origin.target = prefix.find((observation) => observation.date.compare(origin.series.lastObservedDate) > 0 &&
        observationMatches(origin.series.matchingSignature, observation)) ?? null;
    }
    // Supplied future commitments and records beyond cutoff never enter detection.
    const detected = detectSeries(prefix, cutoff, policy);
    for (const series of detected) {
      if (series.status !== "active" || !["supported", "strong"].includes(series.support) || series.expectedNextOccurrence === null) continue;
      const key = JSON.stringify([series.id, series.supportingEventIds]);
      if (seen.has(key)) continue;
      seen.add(key);
      origins.push({ series, target: null, key });
    }
  }
  return { origins: Object.freeze(origins.map((origin) => Object.freeze(origin))), eligibleEventIds };
}
export function rollingOrigins(state: FinancialState, policy: RecurrencePolicy): readonly PredictionOrigin[] {
  return rollingEvaluation(state, policy).origins;
}
export function rollingPredictions(state: FinancialState, policy: RecurrencePolicy): readonly WithheldPrediction[] {
  return Object.freeze(rollingOrigins(state, policy).filter((origin) => origin.target !== null).map(({ series, target, key }) => {
    const actual = target!;
    const difference = series.expectedNextOccurrence!.differenceInDays(actual.date);
    return Object.freeze({
      key, seriesId: series.id, policyVersion: policy.version, trainingEventIds: series.supportingEventIds,
      trainingLastDate: series.lastObservedDate.toISODateString(), predictedDate: series.expectedNextOccurrence!.toISODateString(),
      amount: series.estimatedAmount, actualEventId: actual.eventId, actualDate: actual.date.toISODateString(), actualAmount: actual.amount.toExactDecimalString(),
      direction: actual.direction, absoluteDayError: Math.abs(difference), signedDayError: difference,
    });
  }));
}

interface AmountTotals {
  predictions: number; exact: number; absoluteError: ExactRatio;
  nonzeroActual: ExactRatio; nonzeroError: ExactRatio; unsafeError: ExactRatio; conservativeError: ExactRatio;
  expenseUnderCount: number; expenseUnder: ExactRatio; expenseOverCount: number; expenseOver: ExactRatio;
  incomeOverCount: number; incomeOver: ExactRatio; incomeUnderCount: number; incomeUnder: ExactRatio;
  expensePredictions: number; incomePredictions: number;
  expenseActual: ExactRatio; incomeActual: ExactRatio; expenseAbsolute: ExactRatio; incomeAbsolute: ExactRatio;
  expenseRelativeAbsolute: ExactRatio; incomeRelativeAbsolute: ExactRatio;
  expenseUnderErrors: ExactRatio[]; expenseOverErrors: ExactRatio[];
  incomeOverErrors: ExactRatio[]; incomeUnderErrors: ExactRatio[];
}
const zero = (): ExactRatio => new ExactRatio(0n);
const ratio = (numerator: number, denominator: number): ExactRatio => denominator === 0 ? zero() : new ExactRatio(BigInt(numerator), BigInt(denominator));
const average = (total: ExactRatio, count: number): ExactRatio => count === 0 ? zero() : total.divide(new ExactRatio(BigInt(count)));
function newTotals(): AmountTotals { return { predictions: 0, exact: 0, absoluteError: zero(), nonzeroActual: zero(), nonzeroError: zero(), unsafeError: zero(), conservativeError: zero(), expenseUnderCount: 0, expenseUnder: zero(), expenseOverCount: 0, expenseOver: zero(), incomeOverCount: 0, incomeOver: zero(), incomeUnderCount: 0, incomeUnder: zero(), expensePredictions: 0, incomePredictions: 0, expenseActual: zero(), incomeActual: zero(), expenseAbsolute: zero(), incomeAbsolute: zero(), expenseRelativeAbsolute: zero(), incomeRelativeAbsolute: zero(), expenseUnderErrors: [], expenseOverErrors: [], incomeOverErrors: [], incomeUnderErrors: [] }; }
function median(values: readonly ExactRatio[]): ExactRatio {
  const sorted = [...values].sort((a, b) => a.compare(b)); const middle = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? zero() : sorted.length % 2 === 1 ? sorted[middle]! : sorted[middle - 1]!.add(sorted[middle]!).divide(new ExactRatio(2n));
}
/** Fixed before measurement. All terms are dimensionless exact rationals. */
export const selectionObjective = Object.freeze({
  version: "recurrence-selection-v2",
  invariants: "expense support >=3; income support >=5; income missed allowance =0",
  first: "minimize income unsafe loss = macro-currency income overestimation/actual income + income overestimate rate",
  second: "minimize 4 * expense unsafe loss + over-reservation cost + unsafe date rate + (1-coverage) + unsupported rate/10",
  expenseUnsafe: "macro-currency expense underestimation/actual expense + expense underestimate rate",
  overReservation: "macro-currency expense overestimation/actual expense + macro-currency income underestimation/actual income",
  zeroActual: "zero actual amounts are excluded from relative denominators but included in unsafe counts and monetary totals",
  tieBreak: "lower explicit complexity, higher coverage, higher exact date accuracy, lexicographic policy version",
});
export function policyComplexity(policy: RecurrencePolicy): number {
  const estimatorCost = (value: string): number => ["last", "maximum", "minimum"].includes(value) ? 1 : ["mean", "recent_median"].includes(value) ? 3 : 2;
  return (policy.grouping === "description" ? 1 : policy.grouping === "category" ? 2 : 3) + estimatorCost(policy.expenseEstimator) + estimatorCost(policy.incomeEstimator) +
    [policy.minimumExpenseObservations !== 3, policy.minimumIncomeObservations !== 5, policy.dateToleranceDays !== 0, policy.recentWindow !== 6,
      policy.expenseMissedAllowance !== 1, policy.incomeMissedAllowance !== 0, policy.schedulePreference !== "calendar_first", policy.fixedToleranceNumerator !== 1].filter(Boolean).length;
}
export interface CalibrationMetrics {
  readonly policy: RecurrencePolicy; readonly policyHash: string;
  readonly eligibleObservations: number; readonly eligibleSequences: number;
  readonly snapshotEligibleObservations: number;
  readonly supportedSeries: number; readonly unsupportedSeries: number; readonly ambiguousSeries: number; readonly inactiveSeries: number;
  readonly fixedAmountSeries: number; readonly stableAmountSeries: number; readonly variableAmountSeries: number;
  readonly withheldPredictions: number; readonly predictedObservations: number; readonly coverage: string;
  readonly exactDates: number; readonly withinOneDay: number; readonly withinTwoDays: number; readonly withinThreeDays: number;
  readonly exactDateAccuracy: string; readonly meanAbsoluteDayError: string; readonly medianAbsoluteDayError: string;
  readonly earlyPredictions: number; readonly latePredictions: number; readonly unsafeDatePredictions: number;
  readonly apparentEndChecks: number; readonly apparentFalseContinuations: number;
  readonly exactAmounts: number; readonly relativeErrorCount: number; readonly weightedRelativeError: string;
  readonly unsafeRelativeError: string; readonly conservativeRelativeError: string;
  readonly expenseUnderestimates: number; readonly expenseOverestimates: number;
  readonly incomeOverestimates: number; readonly incomeUnderestimates: number;
  readonly incomeRejected: number; readonly conservativeExpenses: number;
  readonly exclusions: Readonly<Record<string, number>>;
  readonly amountByCurrency: Readonly<Record<string, Readonly<Record<string, string | number>>>>;
  readonly selectionScore: string;
  readonly unsafeIncomeLoss: string; readonly unsafeExpenseLoss: string;
  readonly overReservationCost: string; readonly directionAwareSafetyLoss: string;
  readonly unsupportedRate: string; readonly complexity: number;
}

export function backtestPolicy(states: readonly FinancialState[], policy: RecurrencePolicy): CalibrationMetrics {
  const totals = new Map<Currency, AmountTotals>();
  const dayErrors: number[] = [];
  const targets = new Set<string>();
  const exclusions: Record<string, number> = {};
  let eligibleObservations = 0, eligibleSequences = 0, supportedSeries = 0, unsupportedSeries = 0, ambiguousSeries = 0, inactiveSeries = 0;
  let snapshotEligibleObservations = 0;
  let exactDates = 0, withinOneDay = 0, withinTwoDays = 0, withinThreeDays = 0, early = 0, late = 0, unsafeDates = 0;
  let apparentEndChecks = 0, apparentFalseContinuations = 0, incomeRejected = 0, conservativeExpenses = 0;
  let fixedAmountSeries = 0, stableAmountSeries = 0, variableAmountSeries = 0;
  let relativeErrorCount = 0;
  for (const state of [...states].sort((a, b) => a.request.id < b.request.id ? -1 : a.request.id > b.request.id ? 1 : 0)) {
    const analysis = analyzeRecurrence(state, policy);
    const chronologicalEvaluation = rollingEvaluation(state, policy);
    eligibleObservations += chronologicalEvaluation.eligibleEventIds.size;
    snapshotEligibleObservations += analysis.observations.length; eligibleSequences += analysis.series.length;
    for (const excluded of analysis.exclusions) for (const reason of excluded.reasons) exclusions[reason] = (exclusions[reason] ?? 0) + 1;
    for (const series of analysis.series) {
      if (series.schedule.kind === "unsupported" || series.support === "low") unsupportedSeries++;
      else supportedSeries++;
      if (series.status === "ambiguous") ambiguousSeries++;
      if (series.status === "inactive") inactiveSeries++;
      if (series.amountBehavior === "fixed") fixedAmountSeries++; else if (series.amountBehavior === "stable_with_variation") stableAmountSeries++; else variableAmountSeries++;
      if (series.direction === "credit" && (series.status !== "active" || series.support !== "strong")) incomeRejected++;
      if (series.direction === "debit" && series.status === "ambiguous") conservativeExpenses++;
    }
    for (const origin of chronologicalEvaluation.origins) {
      const { series, target } = origin;
      if (target === null) {
        // Right-censor dates at the request boundary; absence is only an apparent end.
        if (series.expectedNextOccurrence!.addDays(policy.dateToleranceDays).compare(state.request.date) < 0) {
          apparentEndChecks++;
          apparentFalseContinuations++;
        }
        continue;
      }
      const dayError = series.expectedNextOccurrence!.differenceInDays(target.date);
      const absoluteDayError = Math.abs(dayError); dayErrors.push(absoluteDayError);
      if (dayError === 0) exactDates++; if (absoluteDayError <= 1) withinOneDay++; if (absoluteDayError <= 2) withinTwoDays++; if (absoluteDayError <= 3) withinThreeDays++;
      if (dayError < 0) early++; if (dayError > 0) late++;
      if ((target.direction === "credit" && dayError < 0) || (target.direction === "debit" && dayError > 0)) unsafeDates++;
      targets.add(JSON.stringify([state.request.id, target.eventId]));
      const amount = ExactRatio.fromAmount(series.estimatedAmount);
      const actual = ExactRatio.fromDecimalString(target.amount.toExactDecimalString());
      const signedError = amount.subtract(actual); const absoluteError = signedError.abs();
      const bucket = totals.get(target.amount.currency) ?? newTotals(); totals.set(target.amount.currency, bucket);
      bucket.predictions++; bucket.absoluteError = bucket.absoluteError.add(absoluteError);
      if (signedError.numerator === 0n) bucket.exact++;
      const unsafe = target.direction === "debit" ? signedError.numerator < 0n : signedError.numerator > 0n;
      if (actual.numerator !== 0n) {
        relativeErrorCount++; bucket.nonzeroActual = bucket.nonzeroActual.add(actual.abs()); bucket.nonzeroError = bucket.nonzeroError.add(absoluteError);
        if (unsafe) bucket.unsafeError = bucket.unsafeError.add(absoluteError); else bucket.conservativeError = bucket.conservativeError.add(absoluteError);
      }
      if (target.direction === "debit") {
        bucket.expensePredictions++; bucket.expenseAbsolute = bucket.expenseAbsolute.add(absoluteError);
        if (actual.numerator !== 0n) { bucket.expenseActual = bucket.expenseActual.add(actual.abs()); bucket.expenseRelativeAbsolute = bucket.expenseRelativeAbsolute.add(absoluteError); }
        if (signedError.numerator < 0n) bucket.expenseUnderErrors.push(absoluteError);
        if (signedError.numerator > 0n) bucket.expenseOverErrors.push(absoluteError);
        if (signedError.numerator < 0n) { bucket.expenseUnderCount++; bucket.expenseUnder = bucket.expenseUnder.add(absoluteError); }
        if (signedError.numerator > 0n) { bucket.expenseOverCount++; bucket.expenseOver = bucket.expenseOver.add(absoluteError); }
      } else {
        bucket.incomePredictions++; bucket.incomeAbsolute = bucket.incomeAbsolute.add(absoluteError);
        if (actual.numerator !== 0n) { bucket.incomeActual = bucket.incomeActual.add(actual.abs()); bucket.incomeRelativeAbsolute = bucket.incomeRelativeAbsolute.add(absoluteError); }
        if (signedError.numerator > 0n) bucket.incomeOverErrors.push(absoluteError);
        if (signedError.numerator < 0n) bucket.incomeUnderErrors.push(absoluteError);
        if (signedError.numerator > 0n) { bucket.incomeOverCount++; bucket.incomeOver = bucket.incomeOver.add(absoluteError); }
        if (signedError.numerator < 0n) { bucket.incomeUnderCount++; bucket.incomeUnder = bucket.incomeUnder.add(absoluteError); }
      }
    }
  }
  const amountByCurrency: Record<string, Readonly<Record<string, string | number>>> = {};
  let relativeTotal = zero(), unsafeRelative = zero(), conservativeRelative = zero(), relativeCurrencies = 0;
  for (const bucket of totals.values()) if (bucket.nonzeroActual.numerator > 0n) {
    relativeCurrencies++;
    relativeTotal = relativeTotal.add(bucket.nonzeroError.divide(bucket.nonzeroActual));
    unsafeRelative = unsafeRelative.add(bucket.unsafeError.divide(bucket.nonzeroActual));
    conservativeRelative = conservativeRelative.add(bucket.conservativeError.divide(bucket.nonzeroActual));
  }
  for (const [currency, bucket] of [...totals].sort(([a], [b]) => a < b ? -1 : 1)) amountByCurrency[currency] = Object.freeze({
    predictions: bucket.predictions, exact: bucket.exact, absolute_error: bucket.absoluteError.toFractionString(), mean_absolute_error: average(bucket.absoluteError, bucket.predictions).toFractionString(),
    expense_under_count: bucket.expenseUnderCount, expense_under_magnitude: bucket.expenseUnder.toFractionString(),
    expense_over_count: bucket.expenseOverCount, expense_over_magnitude: bucket.expenseOver.toFractionString(),
    income_over_count: bucket.incomeOverCount, income_over_magnitude: bucket.incomeOver.toFractionString(),
    income_under_count: bucket.incomeUnderCount, income_under_magnitude: bucket.incomeUnder.toFractionString(),
    expense_under_mean: average(bucket.expenseUnder, bucket.expenseUnderCount).toFractionString(), expense_under_median: median(bucket.expenseUnderErrors).toFractionString(),
    expense_over_mean: average(bucket.expenseOver, bucket.expenseOverCount).toFractionString(), expense_over_median: median(bucket.expenseOverErrors).toFractionString(),
    income_over_mean: average(bucket.incomeOver, bucket.incomeOverCount).toFractionString(), income_over_median: median(bucket.incomeOverErrors).toFractionString(),
    income_under_mean: average(bucket.incomeUnder, bucket.incomeUnderCount).toFractionString(), income_under_median: median(bucket.incomeUnderErrors).toFractionString(),
    expense_predictions: bucket.expensePredictions, income_predictions: bucket.incomePredictions,
    expense_absolute_error: bucket.expenseAbsolute.toFractionString(), income_absolute_error: bucket.incomeAbsolute.toFractionString(),
    expense_relative_error: bucket.expenseActual.numerator === 0n ? "undefined" : bucket.expenseRelativeAbsolute.divide(bucket.expenseActual).toFractionString(),
    income_relative_error: bucket.incomeActual.numerator === 0n ? "undefined" : bucket.incomeRelativeAbsolute.divide(bucket.incomeActual).toFractionString(),
    expense_actual_nonzero_total: bucket.expenseActual.toFractionString(), income_actual_nonzero_total: bucket.incomeActual.toFractionString(),
    weighted_relative_error: bucket.nonzeroActual.numerator === 0n ? "0" : bucket.nonzeroError.divide(bucket.nonzeroActual).toFractionString(),
  });
  const totalCount = (key: "exact" | "expenseUnderCount" | "expenseOverCount" | "incomeOverCount" | "incomeUnderCount"): number => [...totals.values()].reduce((sum, bucket) => sum + bucket[key], 0);
  const sortedErrors = [...dayErrors].sort((a, b) => a - b); const middle = Math.floor(sortedErrors.length / 2);
  const medianError = sortedErrors.length === 0 ? zero() : sortedErrors.length % 2 === 1 ? new ExactRatio(BigInt(sortedErrors[middle]!)) :
    new ExactRatio(BigInt(sortedErrors[middle - 1]! + sortedErrors[middle]!), 2n);
  const macro = (error: "expenseUnder" | "expenseOver" | "incomeOver" | "incomeUnder", actual: "expenseActual" | "incomeActual"): ExactRatio => {
    const available = [...totals.values()].filter((bucket) => bucket[actual].numerator > 0n);
    return average(available.reduce((sum, bucket) => sum.add(bucket[error].divide(bucket[actual])), zero()), available.length);
  };
  const expensePredictions = [...totals.values()].reduce((sum, bucket) => sum + bucket.expensePredictions, 0);
  const incomePredictions = [...totals.values()].reduce((sum, bucket) => sum + bucket.incomePredictions, 0);
  const unsafeIncomeLoss = macro("incomeOver", "incomeActual").add(ratio(totalCount("incomeOverCount"), incomePredictions));
  const unsafeExpenseLoss = macro("expenseUnder", "expenseActual").add(ratio(totalCount("expenseUnderCount"), expensePredictions));
  const overReservationCost = macro("expenseOver", "expenseActual").add(macro("incomeUnder", "incomeActual"));
  const directionAwareSafetyLoss = unsafeIncomeLoss.add(unsafeExpenseLoss.multiply(new ExactRatio(4n)));
  const unsupportedRate = ratio(unsupportedSeries, eligibleSequences);
  const selectionScore = unsafeExpenseLoss.multiply(new ExactRatio(4n)).add(overReservationCost)
    .add(ratio(unsafeDates, dayErrors.length)).add(new ExactRatio(1n).subtract(ratio(targets.size, eligibleObservations)))
    .add(unsupportedRate.divide(new ExactRatio(10n)));
  return Object.freeze({
    policy, policyHash: policyHash(policy), eligibleObservations, snapshotEligibleObservations, eligibleSequences, supportedSeries, unsupportedSeries, ambiguousSeries, inactiveSeries,
    fixedAmountSeries, stableAmountSeries, variableAmountSeries,
    withheldPredictions: dayErrors.length, predictedObservations: targets.size, coverage: ratio(targets.size, eligibleObservations).toFractionString(),
    exactDates, withinOneDay, withinTwoDays, withinThreeDays, exactDateAccuracy: ratio(exactDates, dayErrors.length).toFractionString(),
    meanAbsoluteDayError: ratio(dayErrors.reduce((sum, error) => sum + error, 0), dayErrors.length).toFractionString(), medianAbsoluteDayError: medianError.toFractionString(),
    earlyPredictions: early, latePredictions: late, unsafeDatePredictions: unsafeDates, apparentEndChecks, apparentFalseContinuations,
    exactAmounts: totalCount("exact"), relativeErrorCount, weightedRelativeError: average(relativeTotal, relativeCurrencies).toFractionString(),
    unsafeRelativeError: average(unsafeRelative, relativeCurrencies).toFractionString(), conservativeRelativeError: average(conservativeRelative, relativeCurrencies).toFractionString(),
    expenseUnderestimates: totalCount("expenseUnderCount"), expenseOverestimates: totalCount("expenseOverCount"), incomeOverestimates: totalCount("incomeOverCount"), incomeUnderestimates: totalCount("incomeUnderCount"),
    incomeRejected, conservativeExpenses, exclusions: Object.freeze(exclusions), amountByCurrency: Object.freeze(amountByCurrency), selectionScore: selectionScore.toFractionString(),
    unsafeIncomeLoss: unsafeIncomeLoss.toFractionString(), unsafeExpenseLoss: unsafeExpenseLoss.toFractionString(), overReservationCost: overReservationCost.toFractionString(),
    directionAwareSafetyLoss: directionAwareSafetyLoss.toFractionString(), unsupportedRate: unsupportedRate.toFractionString(), complexity: policyComplexity(policy),
  });
}
function parseFraction(text: string): ExactRatio { const [numerator = "0", denominator = "1"] = text.split("/"); return new ExactRatio(BigInt(numerator), BigInt(denominator)); }
export function selectPolicy(metrics: readonly CalibrationMetrics[]): CalibrationMetrics {
  const admissible = metrics.filter((metric) => metric.policy.minimumIncomeObservations >= 5 && metric.policy.minimumExpenseObservations >= 3 && metric.policy.incomeMissedAllowance === 0);
  if (admissible.length === 0) throw new Error("No invariant-compliant policy");
  return [...admissible].sort((a, b) => parseFraction(a.unsafeIncomeLoss).compare(parseFraction(b.unsafeIncomeLoss)) ||
    parseFraction(a.selectionScore).compare(parseFraction(b.selectionScore)) || a.complexity - b.complexity ||
    parseFraction(b.coverage).compare(parseFraction(a.coverage)) || parseFraction(b.exactDateAccuracy).compare(parseFraction(a.exactDateAccuracy)) ||
    (a.policy.version < b.policy.version ? -1 : a.policy.version > b.policy.version ? 1 : 0))[0]!;
}

export interface ReportMetadata {
  readonly runtime: string; readonly sourceCommit: string; readonly sourceHash: string; readonly inputHash: string;
  readonly inputFiles: Readonly<Record<string, string>>; readonly sourceFiles: Readonly<Record<string, string>>;
}
const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const manifestHash = (manifest: Readonly<Record<string, string>>): string => digest(JSON.stringify(Object.entries(manifest).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const admissible = (policy: RecurrencePolicy): boolean => policy.minimumIncomeObservations >= 5 && policy.minimumExpenseObservations >= 3 && policy.incomeMissedAllowance === 0;
/** Deterministic renderer. No expected labels, hand-entered metrics, clock or private text. */
export function renderRecurrenceReport(metadata: ReportMetadata, metrics: readonly CalibrationMetrics[], requests: number): string {
  const selected = selectPolicy(metrics);
  const display = (fraction: string): string => parseFraction(fraction).toDisplayDecimal(6);
  const lines = ["# Slice 3 — reproducible historical recurrence calibration", "",
    "Generated by `npm --prefix code run backtest:recurrence -- --dataset ../dataset --write-report`.", "",
    "- Runtime: `" + metadata.runtime + "`",
    "- Source Git reference (HEAD when generated): `" + metadata.sourceCommit + "`",
    "- Source manifest SHA-256 (includes current uncommitted source): `" + metadata.sourceHash + "`",
    "- Input manifest SHA-256: `" + metadata.inputHash + "`",
    "- Selected policy: `" + selected.policy.version + "`; SHA-256: `" + selected.policyHash + "`",
    "- Objective version: `" + selectionObjective.version + "`; SHA-256: `" + digest(JSON.stringify(selectionObjective)) + "`", "",
    "No timestamp is inserted: the same source, inputs, runtime and Git reference generate byte-identical Markdown. The source hash attests the implementation independently of HEAD; a report committed with the code may correctly reference its parent HEAD.", "",
    "## Prespecified selection objective", "",
    ...Object.entries(selectionObjective).map(([key, value]) => "- **" + key + ":** " + value), "",
    "Lexicographic comparison uses unsafe income loss first, then the weighted second objective. There is no epsilon or rounded comparison. Monetary sums never combine currencies. Complexity is grouping cost (description 1/category 2/hybrid 3), estimator cost (last/extremes 1, median/quantiles 2, mean/recent median 3), plus one per nonbaseline threshold or schedule choice. Complexity only breaks exact ties.", "",
    "## Candidate metrics", "",
    "Dimensionless values below are presentation-only floors to six decimals. Exact fractions follow in the selection table and JSON command output. Under/over counts include genuine zero amounts. Relative absolute error is WAPE over nonzero actual amounts, by direction and currency; `undefined` denotes no nonzero actual denominator.", "",
    "| Policy | Admissible | Predictions | Coverage | Unsupported | Date exact | Within 1/2/3 days | Income over/under | Expense under/over | Safety loss | Over-reservation | Complexity | Second objective |",
    "|---|---|---:|---:|---:|---:|---|---|---|---:|---:|---:|---:|"];
  for (const metric of metrics) lines.push("| " + [metric.policy.version, admissible(metric.policy) ? "yes" : "no: support/grace invariant", metric.withheldPredictions,
    display(metric.coverage), display(metric.unsupportedRate), display(metric.exactDateAccuracy), [metric.withinOneDay, metric.withinTwoDays, metric.withinThreeDays].join("/"),
    metric.incomeOverestimates + "/" + metric.incomeUnderestimates, metric.expenseUnderestimates + "/" + metric.expenseOverestimates,
    display(metric.directionAwareSafetyLoss), display(metric.overReservationCost), metric.complexity, display(metric.selectionScore)].join(" | ") + " |");
  lines.push("", "| Policy | Unsafe income loss (first) | Unsafe expense loss | Over-reservation cost | Second objective | Exact date / tolerance accuracy |", "|---|---|---|---|---|---|");
  for (const metric of metrics) lines.push("| " + [metric.policy.version, metric.unsafeIncomeLoss, metric.unsafeExpenseLoss, metric.overReservationCost, metric.selectionScore,
    metric.exactDateAccuracy + " / " + ratio(metric.withinOneDay, metric.withheldPredictions).toFractionString() + " / " + ratio(metric.withinTwoDays, metric.withheldPredictions).toFractionString() + " / " + ratio(metric.withinThreeDays, metric.withheldPredictions).toFractionString()].join(" | ") + " |");
  lines.push("", "## Directional monetary errors for every candidate", "",
    "Each magnitude, mean, median and absolute error is an exact source-currency rational. An empty error subset has count 0, total 0, mean 0 and median 0 (the zeros summarize an empty subset, never missing event amounts).", "",
    "| Policy | Currency | Expense/income prediction counts | Expense under count/total/mean/median | Expense over count/total/mean/median | Expense absolute / relative error | Income over count/total/mean/median | Income under count/total/mean/median | Income absolute / relative error |",
    "|---|---|---|---|---|---|---|---|---|");
  for (const metric of metrics) for (const [currency, bucket] of Object.entries(metric.amountByCurrency)) {
    const errors = (prefix: string): string => [bucket[prefix + "_count"], bucket[prefix + "_magnitude"], bucket[prefix + "_mean"], bucket[prefix + "_median"]].join(" / ");
    lines.push("| " + [metric.policy.version, currency, bucket.expense_predictions + "/" + bucket.income_predictions, errors("expense_under"), errors("expense_over"), bucket.expense_absolute_error + " / " + bucket.expense_relative_error,
      errors("income_over"), errors("income_under"), bucket.income_absolute_error + " / " + bucket.income_relative_error].join(" | ") + " |");
  }
  lines.push("", "## Selected policy and tradeoffs", "",
    "Provisional decision: `" + selected.policy.version + "` wins the exact prespecified lexicographic objective among admissible candidates. Unsafe income loss is " + selected.unsafeIncomeLoss +
    "; unsafe expense loss is " + selected.unsafeExpenseLoss + "; over-reservation cost is " + selected.overReservationCost + "; second objective is " + selected.selectionScore + ".", "",
    "Its expense underestimates number " + selected.expenseUnderestimates + ", expense overestimates " + selected.expenseOverestimates + ", income overestimates " + selected.incomeOverestimates +
    ", and income underestimates " + selected.incomeUnderestimates + ". Over-reservation is penalized explicitly, not treated as free safety. Magnitudes are substantial and remain separate by currency:", "",
    "| Currency | Expense over-reservation total | Expense unsafe underestimation total | Income under-reservation/reference omission total |",
    "|---|---:|---:|---:|");
  for (const [currency, bucket] of Object.entries(selected.amountByCurrency)) lines.push("| " + [currency, bucket.expense_over_magnitude, bucket.expense_under_magnitude, bucket.income_under_magnitude].join(" | ") + " |");
  const incomeTrials = Object.values(selected.amountByCurrency).reduce((sum, bucket) => sum + (bucket.income_predictions as number), 0);
  const expenseTrials = Object.values(selected.amountByCurrency).reduce((sum, bucket) => sum + (bucket.expense_predictions as number), 0);
  lines.push("", "Selected-policy withheld trials: " + expenseTrials + " expenses and " + incomeTrials +
    " income credits. Income estimator validation is limited by this small withheld credit count; zero unsafe income errors is not evidence of broad income calibration. The support threshold and minimum-income estimator remain provisional. Expense underestimation is still nonzero, so a historical maximum is not a guaranteed future upper bound.");
  const alternatives = metrics.filter((metric) => admissible(metric.policy) && metric.policy.version !== selected.policy.version);
  if (alternatives.length > 0) {
    const runnerUp = selectPolicy(alternatives);
    lines.push("", "The next-ranked admissible alternative is `" + runnerUp.policy.version + "`: unsafe income loss " + runnerUp.unsafeIncomeLoss +
      ", unsafe expense loss " + runnerUp.unsafeExpenseLoss + ", over-reservation cost " + runnerUp.overReservationCost +
      ", second objective " + runnerUp.selectionScore + ", coverage " + runnerUp.coverage + ". Selected coverage is " + selected.coverage +
      ". The selected policy's fourfold unsafe-expense contribution is " + parseFraction(selected.unsafeExpenseLoss).multiply(new ExactRatio(4n)).toFractionString() +
      "; the alternative's is " + parseFraction(runnerUp.unsafeExpenseLoss).multiply(new ExactRatio(4n)).toFractionString() +
      ". Both reservation penalties above participate fully. These are prespecified tradeoff weights, not empirically estimated financial utilities; changing that risk preference may change the winner.");
  }
  lines.push("", "Variable series expose both the policy's strict `estimatedAmount` and a recent-window median `referenceAmount` tagged `diagnostic_only`. Fixed series preserve their exact amount in both fields. Only the strict estimate enters backtest safety scoring; the reference must never establish feasibility. This distinction does not assert that extremes guarantee future bounds.", "",
    "## Chronological methodology and temporal purity", "",
    "At each historical availability date (later of posting and settlement), all same-date observations are exposed together. Eligibility, visible lifecycle components, description/category grouping, signatures, IDs, cadence, anchor, amount, activity and confidence are recomputed solely from that prefix. Withheld targets are frozen when they first become eligible at a subsequent origin. Later disputes cannot retroactively remove a previously scored target. Unchanged support is scored once. End checks use observed absence through the request boundary, not future supplied commitments. Endpoint coverage/exclusion counts describe the request snapshot; they are not features supplied to prior predictions.", "",
    "ExactRatio uses reduced BigInt fractions for averages, medians, percentiles, monetary error totals, relative metrics and selection. JavaScript numbers are limited to exact bounded day/count/index operations. Display conversion is an explicit floor and has no effect on selection.", "",
    "## Real-data diagnostics and limitations", "",
    "Requests reconstructed: " + requests + "; chronological eligible observations (coverage denominator): " + selected.eligibleObservations +
    "; eligible observations at request snapshot: " + selected.snapshotEligibleObservations + "; candidate sequences at snapshot: " + selected.eligibleSequences +
    "; supported/unsupported: " + selected.supportedSeries + "/" + selected.unsupportedSeries + "; ambiguous/inactive: " + selected.ambiguousSeries + "/" + selected.inactiveSeries + ".", "",
    "Exact amounts: " + selected.exactAmounts + "; relative-error eligible predictions: " + selected.relativeErrorCount + "; mean/median absolute day error: " + selected.meanAbsoluteDayError + "/" + selected.medianAbsoluteDayError +
    "; early/late: " + selected.earlyPredictions + "/" + selected.latePredictions + "; apparent end checks/false continuations: " + selected.apparentEndChecks + "/" + selected.apparentFalseContinuations + ".", "",
    "Income candidates rejected: " + selected.incomeRejected + "; conservative ambiguous expense candidates: " + selected.conservativeExpenses + "; fixed/stable/variable amount series: " + selected.fixedAmountSeries + "/" + selected.stableAmountSeries + "/" + selected.variableAmountSeries + ".", "",
    "| Exclusion reason (overlapping counts) | Count |", "|---|---:|");
  for (const [reason, count] of Object.entries(selected.exclusions).sort(([a], [b]) => a < b ? -1 : 1)) lines.push("| " + reason + " | " + count + " |");
  lines.push("", "Facts: the metrics above come from historical rows; no solved affordability outputs participate. Hypotheses: merchant/category grouping reflects a coherent purpose, and past cadence indicates continuity. Provisional decisions: support thresholds, activity grace, calendar-first preference, regime window and amount policy. Candidate sensitivity rows quantify observed changes; identical metrics do not distinguish hypotheses.", "",
    "Activity thresholds are NOT empirically validated when measurable end checks are zero, and apparent ends never prove cancellation. All activity confidence is cadence-only or uncertain, explicitly provisional. Inactive and ambiguous series stay distinct; neither supplies eligible income. Uncertain expenses remain `must_review` and cannot silently disappear in a later layer. Seasonal/replacement/termination evidence has not been extracted. Source status records lack revision timestamps: chronological purity is with respect to the supplied event/settlement/posting fields, not a reconstructed historical bank feed. A changed future amount/date/description/status/link/outlier/end cannot influence earlier training; an already-posted record's undocumented later revision cannot be temporally reconstructed.", "",
    "This slice does not forecast 90 days, simulate balances, infer pending holds, calculate affordability, produce payment plans, extract evidence or write predictions. Strict extrema are provisional estimates, not guaranteed future maxima/minima. Source-currency magnitudes cannot be aggregated as home-currency cost without a future FX policy. Linux execution remains unverified directly.", "",
    "Nonblocking debt: reduce Money serialization bounds before untrusted scale inputs; expose canonical payment method/count/frequency before Slice 5.", "",
    "## Hash manifests", "", "Hashes cover raw bytes. The combined hash is SHA-256 of JSON encoding sorted `[filename, SHA-256]` pairs.", "",
    "| Input file | SHA-256 |", "|---|---|");
  for (const [file, hash] of Object.entries(metadata.inputFiles).sort(([a], [b]) => a < b ? -1 : 1)) lines.push("| " + file + " | " + hash + " |");
  lines.push("", "| Source/configuration file | SHA-256 |", "|---|---|");
  for (const [file, hash] of Object.entries(metadata.sourceFiles).sort(([a], [b]) => a < b ? -1 : 1)) lines.push("| " + file + " | " + hash + " |");
  return lines.join("\n") + "\n";
}

export async function runBacktest(args: readonly string[]): Promise<number> {
  const writeReport = args.includes("--write-report");
  if (args.filter((argument) => argument === "--write-report").length > 1) throw new Error("Duplicate report flag");
  const datasetDirectory = parseDatasetArgument(args.filter((argument) => argument !== "--write-report"));
  const inputFiles: Record<string, string> = {};
  const loaded = await loadProduction(datasetDirectory, async (path) => {
    const filename = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
    if (!(Object.values(productionFiles) as readonly string[]).includes(filename)) throw new Error("File outside production allowlist");
    const bytes = await readFile(path); inputFiles[filename] = digest(bytes); return bytes;
  });
  const inspection = await buildIndexes(loaded, datasetDirectory);
  if (inspection.issues.some((issue) => issue.severity === "error")) { console.error("BACKTEST_INGESTION_ERROR: blocking structural diagnostics"); return 1; }
  const data = normalizeData(inspection); const states: FinancialState[] = [];
  for (const id of [...data.requests.keys()].sort()) {
    const result = reconstructState(data, id);
    if (result.state === null) { console.error("BACKTEST_STATE_ERROR: " + id + " " + result.issues.filter((issue) => issue.severity === "error").map((issue) => issue.code).join(",")); return 1; }
    states.push(result.state);
  }
  const metrics: CalibrationMetrics[] = [];
  for (const policy of candidatePolicies) {
    console.error("Backtesting " + policy.version);
    metrics.push(backtestPolicy(states, policy));
  }
  const selected = selectPolicy(metrics);
  const sourceFiles: Record<string, string> = {};
  for (const file of ["evaluation/backtest.ts", "src/finance/recurrence.ts", "src/finance/state.ts", "src/data/load.ts", "src/data/indexes.ts", "src/data/normalize.ts",
    "src/core/dates.ts", "src/core/money.ts", "src/core/fx.ts", "src/domain.ts", "src/schemas.ts", "src/config.ts", "src/main.ts", "tests/recurrence.test.ts", "package.json", "package-lock.json", "tsconfig.json"]) {
    sourceFiles[file] = digest(await readFile(resolve(projectRoot, file)));
  }
  let sourceCommit = "unavailable";
  try { sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { /* Packaged code need not include .git. */ }
  const metadata: ReportMetadata = { runtime: process.version, sourceCommit, sourceHash: manifestHash(sourceFiles), inputHash: manifestHash(inputFiles), inputFiles, sourceFiles };
  if (writeReport) await writeFile(resolve(projectRoot, "evaluation/recurrence_report.md"), renderRecurrenceReport(metadata, metrics, states.length), "utf8");
  console.log(JSON.stringify({ ...metadata, requests: states.length, objective: selectionObjective, selectedPolicy: selected.policy, selectedPolicyHash: selected.policyHash, metrics }, null, 2));
  return 0;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runBacktest(process.argv.slice(2)); }
  catch { console.error("BACKTEST_CLI_ERROR: invalid arguments or unexpected backtest failure"); process.exitCode = 1; }
}
