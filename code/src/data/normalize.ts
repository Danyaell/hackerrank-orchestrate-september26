import { Money } from "../core/money.js";
import { DateOnly } from "../core/dates.js";
import { FxIndex } from "../core/fx.js";
import { sortIssues } from "../config.js";
import type {
  AmountValue, CanonicalEvent, CanonicalEvidence, CanonicalPaymentOption, CanonicalProfile,
  CanonicalRequest, InspectionResult, Issue, NormalizedData, Provenance,
} from "../domain.js";

/** Canonical copies retain raw records and provenance; no lifecycle or cash policy here. */
export function normalizeData(input: InspectionResult): NormalizedData {
  const profiles = new Map<string, CanonicalProfile>();
  const requests = new Map<string, CanonicalRequest>();
  const events: CanonicalEvent[] = [];
  const eventBuckets = new Map<string, CanonicalEvent[]>();
  const paymentOptions: CanonicalPaymentOption[] = [];
  const evidence: CanonicalEvidence[] = [];
  // Never turn a partially rejected ingestion result into a trusted financial context.
  // Valid missing-amount warnings are re-emitted for the relevant state, not every user.
  const issues: Issue[] = input.issues.filter((issue) => issue.severity === "error");
  const error = (source: Provenance, field: string, explanation: string): void => {
    issues.push({ ...source, code: "NORMALIZATION_ERROR", severity: "error", field, explanation });
  };
  for (const row of input.tables.financial_profiles) {
    if (profiles.has(row.data.user_id)) { error(row.source, "user_id", "Duplicate canonical profile"); continue; }
    profiles.set(row.data.user_id, Object.freeze({
      id: row.data.user_id, homeCurrency: row.data.home_currency,
      startingBalance: Money.fromNonNegativeDecimalString(row.data.current_available_balance, row.data.home_currency),
      minimumBalance: Money.fromNonNegativeDecimalString(row.data.minimum_balance_to_keep, row.data.home_currency),
      source: row.source, raw: row.data,
    }));
  }
  for (const row of input.tables.requests) {
    const profile = profiles.get(row.data.user_id);
    if (!profile) { error(row.source, "user_id", "Canonical request has no profile"); continue; }
    if (requests.has(row.data.request_id)) { error(row.source, "request_id", "Duplicate canonical request"); continue; }
    requests.set(row.data.request_id, Object.freeze({
      id: row.data.request_id, userId: row.data.user_id, date: DateOnly.parse(row.data.request_date),
      deadline: DateOnly.parse(row.data.desired_completion_date),
      amount: Money.fromNonNegativeDecimalString(row.data.requested_amount, profile.homeCurrency),
      source: row.source, raw: row.data,
    }));
  }
  for (const row of input.tables.financial_events) {
    const money = row.data.amount === null ? null : Money.fromNonNegativeDecimalString(row.data.amount, row.data.currency);
    const amount: AmountValue = money === null ?
      Object.freeze({ kind: "unresolved", originalText: null, reason: "missing_amount" }) :
      Object.freeze({ kind: "resolved", originalText: row.data.amount!, money, reportedZero: money.isZero() });
    const event: CanonicalEvent = Object.freeze({
      id: row.data.event_id, userId: row.data.user_id, amount, currency: row.data.currency,
      eventDate: DateOnly.parse(row.data.event_date),
      settlementDate: row.data.settlement_date === null ? null : DateOnly.parse(row.data.settlement_date),
      linkedEventId: row.data.linked_event_id, status: row.data.status, direction: row.data.direction,
      type: row.data.event_type, minimumAllowedAmount: row.data.minimum_allowed_amount === null ? null :
        Money.fromNonNegativeDecimalString(row.data.minimum_allowed_amount, row.data.currency),
      source: row.source, raw: row.data,
    });
    events.push(event);
    eventBuckets.set(event.id, [...(eventBuckets.get(event.id) ?? []), event]);
  }
  for (const row of input.tables.request_payment_options) {
    const request = requests.get(row.data.request_id);
    if (!request) { error(row.source, "request_id", "Canonical payment option has no active request"); continue; }
    const currency = request.amount.currency;
    paymentOptions.push(Object.freeze({
      id: row.data.payment_option_id, requestId: row.data.request_id,
      paymentAmount: Money.fromNonNegativeDecimalString(row.data.payment_amount, currency),
      financingFee: Money.fromNonNegativeDecimalString(row.data.financing_fee, currency),
      totalPayableAmount: Money.fromNonNegativeDecimalString(row.data.total_payable_amount, currency),
      firstPaymentDate: DateOnly.parse(row.data.first_payment_date), source: row.source, raw: row.data,
    }));
  }
  for (const row of input.tables.messages) evidence.push(Object.freeze({
    id: row.data.message_id, kind: "message", userId: row.data.user_id, requestId: row.data.request_id,
    relatedEventId: row.data.related_event_id, sentAt: row.data.sent_at, source: row.source, raw: row.data,
  }));
  for (const row of input.tables.images) evidence.push(Object.freeze({
    id: row.data.image_id, kind: "image", userId: row.data.user_id, requestId: row.data.request_id,
    relatedEventId: row.data.related_event_id, sentAt: null, source: row.source, raw: row.data,
  }));
  const frozenBuckets = new Map([...eventBuckets].map(([key, bucket]) => [key, Object.freeze(bucket)]));
  const fx = new FxIndex(input.tables.exchange_rates);
  return Object.freeze({
    profiles, requests, events: Object.freeze(events), eventBuckets: frozenBuckets,
    paymentOptions: Object.freeze(paymentOptions), evidence: Object.freeze(evidence),
    fx, issues: sortIssues([...issues, ...fx.issues]),
  });
}
