import { Money } from "./money.js";
import type { DateOnly } from "./dates.js";
import type { Currency, ExchangeRate, FxConversion, Issue, Provenance, RecordWithSource } from "../domain.js";
import { sortIssues } from "../config.js";

const key = (date: string, from: Currency, to: Currency): string => JSON.stringify([date, from, to]);
export class FxIndex {
  readonly #rows = new Map<string, readonly RecordWithSource<ExchangeRate>[]>();
  readonly issues: readonly Issue[];
  constructor(rows: readonly RecordWithSource<ExchangeRate>[]) {
    const buckets = new Map<string, RecordWithSource<ExchangeRate>[]>();
    for (const row of rows) {
      const value = key(row.data.rate_date, row.data.from_currency, row.data.to_currency);
      buckets.set(value, [...(buckets.get(value) ?? []), row]);
    }
    const issues: Issue[] = [];
    for (const [value, bucket] of buckets) {
      this.#rows.set(value, Object.freeze(bucket));
      if (bucket.length > 1) {
        const conflicting = new Set(bucket.map((row) => Money.fromNonNegativeDecimalString(row.data.rate, row.data.to_currency).toExactDecimalString())).size > 1;
        for (const row of bucket.slice(1)) issues.push({
          ...row.source, severity: "error", code: conflicting ? "FX_CONFLICTING_RATE" : "FX_DUPLICATE_RATE",
          field: "rate_date,from_currency,to_currency", explanation: "Directed dated rate is not unique; no rate was selected",
        });
      }
    }
    this.issues = sortIssues(issues);
    Object.freeze(this);
  }
  validateCoverage(from: Currency, home: Currency, settlementDate: DateOnly | null, source: Provenance): readonly Issue[] {
    const fail = (code: string, explanation: string): readonly Issue[] =>
      [{ ...source, severity: "error", code, field: code === "FX_MISSING_SETTLEMENT_DATE" ? "settlement_date" : "currency", explanation }];
    if (from === home) return [];
    if (settlementDate === null) return fail("FX_MISSING_SETTLEMENT_DATE", "Foreign cash conversion requires the settlement date");
    const date = settlementDate.toISODateString();
    const bucket = this.#rows.get(key(date, from, home));
    if (!bucket) return fail(this.#rows.has(key(date, home, from)) ? "FX_WRONG_DIRECTION" : "FX_MISSING_RATE",
      "No supplied settlement-date rate exists in the required direction");
    if (bucket.length !== 1) return fail("FX_NON_UNIQUE_RATE", "Conversion rejected because the directed dated rate is duplicated or conflicting");
    return [];
  }
  convert(sourceAmount: Money, homeCurrency: Currency, settlementDate: DateOnly | null, source: Provenance):
    { readonly conversion: FxConversion | null; readonly issues: readonly Issue[] } {
    if (sourceAmount.currency === homeCurrency) return {
      conversion: Object.freeze({ source, original: sourceAmount, converted: sourceAmount, rate: null, rateDate: null, rateSource: null }), issues: [],
    };
    const coverageIssues = this.validateCoverage(sourceAmount.currency, homeCurrency, settlementDate, source);
    if (coverageIssues.length > 0) return { conversion: null, issues: coverageIssues };
    const date = settlementDate!.toISODateString();
    const bucket = this.#rows.get(key(date, sourceAmount.currency, homeCurrency));
    const row = bucket![0]!;
    const convertedValue = sourceAmount.multiplyByRate(row.data.rate).toExactDecimalString();
    return {
      conversion: Object.freeze({
        source, original: sourceAmount, converted: Money.fromDecimalString(convertedValue, homeCurrency),
        rate: row.data.rate, rateDate: settlementDate, rateSource: row.source,
      }),
      issues: [],
    };
  }
}
