import type { z } from "zod";
import type { schemas } from "./schemas.js";

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
export type DateOnly = string;

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
