import type { z } from "zod";
import type { schemas } from "./schemas.js";
import type { Money } from "./core/money.js";
import type { DateOnly } from "./core/dates.js";
import type { FxIndex } from "./core/fx.js";

// Monetary values are lexical decimal strings, not calculated or converted.
export type DecimalString = string;
export type TableName = keyof typeof schemas;
export type Request = z.output<typeof schemas.requests>;
export type UserProfile = z.output<typeof schemas.financial_profiles>;
export type FinancialEvent = z.output<typeof schemas.financial_events>;
export type PaymentOption = z.output<typeof schemas.request_payment_options>;
export type Message = z.output<typeof schemas.messages>;
export type ImageMetadata = z.output<typeof schemas.images>;
export type ExchangeRate = z.output<typeof schemas.exchange_rates>;
export type Currency = UserProfile["home_currency"];
export type { DateOnly };

export interface Provenance {
  readonly filename: string;
  /** Logical data record number, starting at 1; excludes the header. */
  readonly row: number;
  readonly recordId: string | null;
}
export interface RecordWithSource<T> {
  readonly data: Readonly<T>;
  readonly source: Provenance;
}
export type Tables = {
  readonly [K in TableName]: readonly RecordWithSource<z.output<(typeof schemas)[K]>>[];
};
export interface Issue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly filename: string;
  /** 0 denotes the header; null denotes a file-level error. */
  readonly row: number | null;
  readonly field: string | null;
  readonly recordId: string | null;
  readonly explanation: string;
}
export interface TableCount {
  readonly loaded: number;
  readonly valid: number;
  readonly active: number;
  readonly ignored: number;
  readonly invalid: number;
}
export interface LoadedData {
  readonly filesLoaded: readonly string[];
  readonly tables: Tables;
  readonly loadedCounts: Readonly<Record<TableName, number>>;
  readonly issues: readonly Issue[];
}
export interface DataIndexes {
  readonly requestsById: ReadonlyMap<string, RecordWithSource<Request>>;
  readonly profilesByUser: ReadonlyMap<string, RecordWithSource<UserProfile>>;
  readonly eventsById: ReadonlyMap<string, RecordWithSource<FinancialEvent>>;
  readonly eventsByUser: ReadonlyMap<string, readonly RecordWithSource<FinancialEvent>[]>;
  readonly optionsByRequest: ReadonlyMap<string, readonly RecordWithSource<PaymentOption>[]>;
  readonly messagesByUser: ReadonlyMap<string, readonly RecordWithSource<Message>[]>;
  readonly messagesByRequest: ReadonlyMap<string, readonly RecordWithSource<Message>[]>;
  readonly messagesByEvent: ReadonlyMap<string, readonly RecordWithSource<Message>[]>;
  readonly imagesByUser: ReadonlyMap<string, readonly RecordWithSource<ImageMetadata>[]>;
  readonly imagesByRequest: ReadonlyMap<string, readonly RecordWithSource<ImageMetadata>[]>;
  readonly imagesByEvent: ReadonlyMap<string, readonly RecordWithSource<ImageMetadata>[]>;
  readonly ratesByDirectedPair: ReadonlyMap<string, RecordWithSource<ExchangeRate>>;
}
export interface InspectionResult {
  readonly filesLoaded: readonly string[];
  readonly indexes: DataIndexes;
  readonly tables: Tables;
  readonly counts: Readonly<Record<TableName, TableCount>>;
  readonly issues: readonly Issue[];
}

export type AmountValue =
  | { readonly kind: "resolved"; readonly originalText: string; readonly money: Money; readonly reportedZero: boolean }
  | { readonly kind: "unresolved"; readonly originalText: null; readonly reason: "missing_amount" };
export interface CanonicalProfile {
  readonly id: string;
  readonly homeCurrency: Currency;
  readonly startingBalance: Money;
  readonly minimumBalance: Money;
  readonly source: Provenance;
  readonly raw: Readonly<UserProfile>;
}
export interface CanonicalRequest {
  readonly id: string;
  readonly userId: string;
  readonly date: DateOnly;
  readonly deadline: DateOnly;
  readonly amount: Money;
  readonly source: Provenance;
  readonly raw: Readonly<Request>;
}
export interface CanonicalEvent {
  readonly id: string;
  readonly userId: string;
  readonly amount: AmountValue;
  readonly currency: Currency;
  readonly eventDate: DateOnly;
  readonly settlementDate: DateOnly | null;
  readonly linkedEventId: string | null;
  readonly status: FinancialEvent["status"];
  readonly direction: FinancialEvent["direction"];
  readonly type: FinancialEvent["event_type"];
  readonly minimumAllowedAmount: Money | null;
  readonly source: Provenance;
  readonly raw: Readonly<FinancialEvent>;
}
export interface CanonicalPaymentOption {
  readonly id: string;
  readonly requestId: string;
  readonly method: PaymentOption["payment_method"];
  readonly numberOfPayments: bigint;
  readonly paymentFrequencyDays: bigint | null;
  readonly paymentAmount: Money;
  readonly financingFee: Money;
  readonly totalPayableAmount: Money;
  readonly firstPaymentDate: DateOnly;
  readonly source: Provenance;
  readonly raw: Readonly<PaymentOption>;
}
export interface CanonicalEvidence {
  readonly id: string;
  readonly kind: "message" | "image";
  readonly userId: string;
  readonly requestId: string | null;
  readonly relatedEventId: string | null;
  readonly sentAt: string | null;
  readonly source: Provenance;
  readonly raw: Readonly<Message | ImageMetadata>;
}
export interface NormalizedData {
  readonly profiles: ReadonlyMap<string, CanonicalProfile>;
  readonly requests: ReadonlyMap<string, CanonicalRequest>;
  readonly events: readonly CanonicalEvent[];
  readonly eventBuckets: ReadonlyMap<string, readonly CanonicalEvent[]>;
  readonly paymentOptions: readonly CanonicalPaymentOption[];
  readonly evidence: readonly CanonicalEvidence[];
  readonly fx: FxIndex;
  readonly issues: readonly Issue[];
}
export interface FxConversion {
  readonly source: Provenance;
  readonly original: Money;
  readonly converted: Money;
  readonly rate: string | null;
  readonly rateDate: DateOnly | null;
  readonly rateSource: Provenance | null;
}
export type StateCategory = "historical_settled" | "confirmed_future" | "same_day_dated" |
  "pending_debit" | "pending_credit" | "failed" | "cancelled" | "non_cash" | "ambiguous_obligation";
export interface CashFact {
  readonly id: string;
  readonly eventId: string;
  readonly date: DateOnly;
  readonly direction: "debit" | "credit";
  readonly movement: Money;
  readonly conversion: FxConversion;
  readonly source: Provenance;
}
export interface StateRecord {
  readonly event: CanonicalEvent;
  readonly category: StateCategory;
  readonly conversion: FxConversion | null;
  readonly cashFact: CashFact | null;
  readonly realizedCash: "dated_fact" | "none";
  readonly unresolvedReasons: readonly string[];
  readonly messageIds: readonly string[];
  readonly imageIds: readonly string[];
}
export interface LifecycleEdge {
  readonly earlierEventId: string;
  readonly laterEventId: string;
  readonly kind: "authorization_replacement" | "settled_refund" | "pending_refund" |
    "debt_retry" | "investment_valuation" | "investment_sale" | "ambiguous";
}
export interface LifecycleGroup {
  readonly id: string;
  readonly memberIds: readonly string[];
  readonly edges: readonly LifecycleEdge[];
  readonly ambiguous: boolean;
}
export type PendingBalancePolicy = "includes_holds" | "excludes_holds" | "unknown";
export interface FinancialState {
  readonly request: CanonicalRequest;
  readonly profile: CanonicalProfile;
  readonly startingBalance: Money;
  readonly pendingBalancePolicy: PendingBalancePolicy;
  readonly sameDayOrdering: "unresolved";
  readonly sameDaySnapshotPolicy: "unresolved";
  readonly records: readonly StateRecord[];
  readonly historicalCashFacts: readonly CashFact[];
  readonly confirmedFutureCommitments: readonly CashFact[];
  readonly sameDayCashFacts: readonly CashFact[];
  readonly pendingDebitExposures: readonly StateRecord[];
  readonly pendingCreditClaims: readonly StateRecord[];
  readonly failedAttempts: readonly StateRecord[];
  readonly cancelledAttempts: readonly StateRecord[];
  readonly nonCashRecords: readonly StateRecord[];
  readonly unresolvedRecords: readonly StateRecord[];
  readonly ambiguousObligations: readonly StateRecord[];
  readonly lifecycleGroups: readonly LifecycleGroup[];
  readonly issues: readonly Issue[];
}
export interface StateResult {
  readonly state: FinancialState | null;
  readonly issues: readonly Issue[];
}

export type GroupingPolicy = "description" | "category" | "hybrid";
export type AmountEstimator = "last" | "mean" | "median" | "recent_median" | "upper_quantile" | "lower_quantile" | "maximum" | "minimum";
/** Exact rational for means/medians; repeating decimals are never silently rounded. */
export interface RationalAmount { readonly numerator: string; readonly denominator: string; readonly currency: Currency }
export interface RecurrencePolicy {
  readonly version: string;
  readonly grouping: GroupingPolicy;
  readonly minimumExpenseObservations: number;
  readonly minimumIncomeObservations: number;
  readonly dateToleranceDays: number;
  readonly recentWindow: number;
  readonly expenseMissedAllowance: number;
  readonly incomeMissedAllowance: number;
  readonly expenseEstimator: AmountEstimator;
  readonly incomeEstimator: AmountEstimator;
  readonly fixedToleranceNumerator: number;
  readonly fixedToleranceDenominator: number;
  readonly schedulePreference: "calendar_first" | "fixed_first";
}
export interface RecurrenceObservation {
  readonly eventId: string; readonly userId: string;
  readonly direction: "debit" | "credit"; readonly eventType: FinancialEvent["event_type"];
  readonly category: string; readonly description: string; readonly flexibility: FinancialEvent["flexibility"];
  readonly amount: Money; readonly date: DateOnly; readonly source: Provenance;
}
export interface RecurrenceSchedule {
  readonly kind: "calendar_monthly" | "fixed_interval_days" | "unsupported";
  readonly anchorDay: number | null; readonly monthEnd: boolean;
  readonly intervalDays: number | null;
  readonly deviations: readonly number[];
  readonly matchedGaps: number; readonly totalGaps: number;
}
export interface RecurrenceSeries {
  readonly id: string; readonly userId: string; readonly direction: "debit" | "credit";
  readonly eventType: FinancialEvent["event_type"]; readonly category: string; readonly currency: Currency;
  readonly groupingPolicy: GroupingPolicy; readonly matchingSignature: string;
  readonly supportingEventIds: readonly string[]; readonly provenance: readonly Provenance[];
  readonly firstObservedDate: DateOnly; readonly lastObservedDate: DateOnly; readonly observationCount: number;
  readonly schedule: RecurrenceSchedule; readonly amountModel: AmountEstimator | "fixed";
  readonly amountBehavior: "fixed" | "stable_with_variation" | "variable";
  readonly estimatedAmount: RationalAmount; readonly expectedNextOccurrence: DateOnly | null;
  /** Reference estimate is never an input to financial feasibility or safety scoring. */
  readonly referenceAmount: RationalAmount; readonly referenceAmountUse: "diagnostic_only";
  readonly activityPolicy: "provisional"; readonly activityConfidence: "cadence_only" | "uncertain";
  readonly incomeInferenceEligible: boolean; readonly expenseContinuity: "supported" | "must_review" | null;
  readonly status: "active" | "inactive" | "ambiguous";
  readonly support: "strong" | "supported" | "low" | "unsupported";
  readonly missedOccurrences: number; readonly regimeChanged: boolean;
  readonly suppliedFutureEventIds: readonly string[]; readonly diagnostics: readonly string[];
}
export interface RecurrenceExclusion { readonly eventId: string; readonly reasons: readonly string[]; readonly source: Provenance }
export interface RecurrenceResult {
  readonly policyVersion: string; readonly policyHash: string; readonly series: readonly RecurrenceSeries[];
  readonly observations: readonly RecurrenceObservation[]; readonly exclusions: readonly RecurrenceExclusion[];
}

export type PendingScenario = "includes_holds" | "excludes_holds";
export type SameDayOrder = "debits_before_credits" | "credits_before_debits";
export interface ForecastIssue extends Issue {
  readonly effect: "blocking" | "conservative_unresolved" | "informational";
  readonly obligationId: string;
  readonly provenance: readonly Provenance[];
}
export interface ForecastObligation {
  readonly id: string; readonly knownAmount: Money | null; readonly date: DateOnly | null;
  readonly sourceEventIds: readonly string[]; readonly seriesId: string | null;
  readonly provenance: readonly Provenance[]; readonly reason: string;
}
export interface ForecastMovement {
  readonly id: string; readonly date: DateOnly; readonly amount: Money; readonly original: Money;
  readonly kind: "confirmed_future_commitment" | "generated_recurring_income" | "generated_recurring_expense" |
    "pending_hold_transition" | "injected_diagnostic_payment" | "conservative_reserve";
  readonly operation: "cash" | "hold_open" | "hold_settle" | "reserve_open";
  readonly obligationId: string; readonly sourceEventIds: readonly string[]; readonly seriesId: string | null;
  readonly fx: FxConversion | null; readonly confidence: "confirmed" | "supported" | "uncertain";
  readonly evidenceState: "confirmed" | "inferred" | "ambiguous" | "unresolved";
  readonly provenance: readonly Provenance[];
  readonly deduplication: { readonly decision: "retained" | "suppressed"; readonly rationale: string; readonly matchedMovementId: string | null };
}
export interface FinancialForecast {
  readonly requestId: string; readonly userId: string; readonly currency: Currency;
  readonly start: DateOnly; readonly end: DateOnly; readonly policyVersion: string; readonly policyHash: string;
  readonly policyUsage: "production" | "diagnostic_sensitivity_only";
  readonly recurrencePolicyHash: string;
  readonly movements: readonly ForecastMovement[]; readonly suppressedMovements: readonly ForecastMovement[];
  readonly unresolvedObligations: readonly ForecastObligation[]; readonly issues: readonly ForecastIssue[];
  readonly excludedCreditEventIds: readonly string[];
}
export interface DiagnosticInjection { readonly id: string; readonly date: DateOnly; readonly amount: Money; readonly source: Provenance }
export interface BalanceCheckpoint {
  readonly id: string; readonly date: DateOnly; readonly phase: "opening" | "reserve" | "payment" | "cash" | "closing";
  readonly ledgerBalance: Money; readonly heldAmount: Money; readonly spendableBalance: Money;
  readonly movement: ForecastMovement | null; readonly margin: Money;
}
export interface DailyTrace {
  readonly date: DateOnly; readonly openingBalance: Money; readonly openingSpendable: Money;
  readonly heldAmount: Money; readonly spendableBalance: Money; readonly checkpoints: readonly BalanceCheckpoint[];
  readonly closingBalance: Money; readonly minimumBalance: Money;
}
export interface SimulationTrace {
  readonly requestId: string; readonly forecastPolicyHash: string; readonly pendingScenario: PendingScenario; readonly sameDayOrder: SameDayOrder;
  readonly days: readonly DailyTrace[]; readonly checkpoints: readonly BalanceCheckpoint[];
  readonly minimumCheckpoint: BalanceCheckpoint; readonly minimumBalance: Money;
  readonly breaches: readonly BalanceCheckpoint[]; readonly issues: readonly Issue[];
  readonly pendingAccounting: ReadonlyMap<string, { readonly opened: boolean; readonly settled: boolean }>;
}
export interface BaselineCapacity {
  readonly status: "valid" | "baseline_unsafe" | "blocked" | "conservative_unresolved";
  readonly baselineBreached: boolean;
  readonly incrementalCapacity: { readonly status: "positive_incremental_capacity" | "zero_incremental_capacity"; readonly amount: Money } |
    { readonly status: "not_calculable"; readonly amount: null; readonly reason: "baseline_unsafe" | "blocked" | "conservative_unresolved" };
  readonly fullPaymentFeasibility: { readonly status: "full_payment_supported"; readonly date: DateOnly; readonly reason: "full_payment_supported" } |
    { readonly status: "no_full_payment_within_horizon"; readonly date: null; readonly reason: "no_full_payment_within_horizon" } |
    { readonly status: "not_calculable"; readonly date: null; readonly reason: "baseline_unsafe" | "blocked" | "conservative_unresolved" };
  readonly maximumImmediatePayment: Money | null; readonly earliestFullPaymentDate: DateOnly | null;
  readonly baselineTraces: readonly SimulationTrace[]; readonly limitingScenario: string; readonly limitingCheckpoint: BalanceCheckpoint;
  readonly margin: Money; readonly issues: readonly Issue[];
  readonly pendingSensitive: boolean; readonly sameDaySensitive: boolean;
}

export type PlanMethod = "full_payment" | "wait" | "partial_payment" | "installments";
export interface DatedPayment { readonly date: DateOnly; readonly amount: Money }
export interface SpendingAction {
  readonly kind: "stop" | "reduce_to"; readonly anchorEventId: string; readonly seriesId: string;
  readonly amount: Money | null; readonly provenance: readonly Provenance[];
}
export interface InternalPaymentPlan {
  readonly id: string; readonly requestId: string; readonly method: PlanMethod;
  readonly optionId: string | null; readonly payments: readonly DatedPayment[];
  readonly financingFee: Money; readonly totalPaid: Money; readonly changes: readonly SpendingAction[];
  readonly provenance: readonly Provenance[];
}
export interface PlanIssue extends Issue {
  readonly stage: "eligibility" | "safety" | "input"; readonly candidateId: string | null;
  readonly optionId: string | null; readonly seriesId: string | null;
}
export interface PlanValidation {
  readonly valid: boolean; readonly issues: readonly PlanIssue[];
  readonly scenarios: readonly { readonly pending: PendingScenario; readonly ordering: SameDayOrder; readonly safe: boolean;
    readonly minimum: Money; readonly breaches: readonly BalanceCheckpoint[] }[];
  readonly changedMovementIds: readonly string[];
}
export interface RejectedPlanCandidate {
  readonly plan: InternalPaymentPlan | null; readonly method: PlanMethod; readonly optionId: string | null;
  readonly issues: readonly PlanIssue[];
  readonly validation?: PlanValidation;
}
export interface PlanSelection {
  readonly baseline: BaselineCapacity; readonly baselineSafeToPay: Money | null;
  readonly eligibleCandidates: readonly InternalPaymentPlan[];
  readonly rejectedCandidates: readonly RejectedPlanCandidate[];
  readonly validCandidates: readonly { readonly plan: InternalPaymentPlan; readonly validation: PlanValidation }[];
  readonly selected: InternalPaymentPlan | null;
  readonly rankingTrace: readonly { readonly planId: string; readonly keys: readonly (string | number | boolean | null)[]; readonly firstDifferenceFromNext: number | null }[];
  readonly absenceReasons: readonly ("no_eligible_payment_method" | "no_safe_candidate" | "blocked_input" | "conservative_unresolved_liability" | "deadline" | "preference" | "invalid_option" | "zero_requested_amount")[];
  readonly spendingIssues: readonly PlanIssue[]; readonly optionIssues: readonly PlanIssue[];
  readonly search: { readonly eligibleActions: number; readonly actionSets: number; readonly pruning: string };
}
