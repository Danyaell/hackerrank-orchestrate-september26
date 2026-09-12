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
