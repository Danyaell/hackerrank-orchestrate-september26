import { planPolicy, sortIssues } from "../config.js";
import type { CanonicalPaymentOption, DatedPayment, FinancialForecast, FinancialState, PlanIssue, Provenance } from "../domain.js";

export function planIssue(code: string, stage: PlanIssue["stage"], source: Provenance, explanation: string, field: string,
  candidateId: string | null = null, optionId: string | null = null, seriesId: string | null = null): PlanIssue {
  return Object.freeze({ ...source, code, severity: "warning", stage, field, explanation, candidateId, optionId, seriesId });
}

/** Invalid offers stay rejected offers; their dates or final payment are never repaired. */
export function expandOption(state: FinancialState, forecast: FinancialForecast, option: CanonicalPaymentOption,
  comparator = planPolicy.installmentDurationComparator): { readonly payments: readonly DatedPayment[] | null; readonly issues: readonly PlanIssue[] } {
  const issues: PlanIssue[] = [];
  const reject = (code: string, explanation: string, field: string): void => { issues.push(planIssue(code, "eligibility", option.source, explanation, field, null, option.id)); };
  if (option.requestId !== state.request.id) reject("OPTION_REQUEST_MISMATCH", "Option does not belong to this request", "request_id");
  if (option.numberOfPayments <= 0n) reject("OPTION_PAYMENT_COUNT", "Payment count must be positive", "number_of_payments");
  if (option.method === "full_payment" && option.numberOfPayments !== 1n) reject("OPTION_METHOD_COUNT", "Full-payment option must contain one payment", "number_of_payments");
  if (option.numberOfPayments > 1n && (option.paymentFrequencyDays === null || option.paymentFrequencyDays <= 0n)) reject("OPTION_FREQUENCY", "Multiple payments require a positive supplied frequency", "payment_frequency_days");
  const currency = state.profile.homeCurrency;
  if ([option.paymentAmount, option.financingFee, option.totalPayableAmount].some((amount) => amount.currency !== currency)) reject("OPTION_CURRENCY", "Option terms must use home currency", "payment_amount");
  else {
    if (option.paymentAmount.isZero() || option.paymentAmount.toExactDecimalString().startsWith("-") || option.financingFee.toExactDecimalString().startsWith("-")) reject("OPTION_AMOUNT", "Payment must be positive and financing fee nonnegative", "payment_amount");
    if (option.numberOfPayments > 0n && !option.paymentAmount.multiplyByRate(option.numberOfPayments.toString()).equals(option.totalPayableAmount)) reject("OPTION_TOTAL_SUM", "Identical supplied payments do not sum exactly to supplied total", "total_payable_amount");
    if (!option.totalPayableAmount.equals(state.request.amount.add(option.financingFee))) reject("OPTION_TOTAL_PRICE_FEE", "Total must equal requested principal plus supplied financing fee", "total_payable_amount");
  }
  const span = option.numberOfPayments > 1n && option.paymentFrequencyDays !== null ? (option.numberOfPayments - 1n) * option.paymentFrequencyDays : 0n;
  const available = BigInt(forecast.end.differenceInDays(option.firstPaymentDate));
  if (option.firstPaymentDate.compare(forecast.start) < 0 || span > available || option.numberOfPayments > BigInt(forecast.end.differenceInDays(forecast.start) + 1)) reject("OPTION_OUTSIDE_HORIZON", "Exact supplied schedule lies outside production horizon", "first_payment_date");
  let last = option.firstPaymentDate;
  if (issues.length === 0) {
    last = option.firstPaymentDate.addDays(Number(span)); // bounded whole-day count, never money
    if (last.compare(state.request.deadline) > 0) reject("OPTION_DEADLINE", "Option completes after desired completion date", "first_payment_date");
    if (option.method === "installments") {
      const maximum = state.profile.raw.max_installment_months;
      if (maximum === null) reject("OPTION_MAX_INSTALLMENT_MONTHS", "No installment duration permission is supplied", "number_of_payments");
      else {
        const months = BigInt(maximum);
        if (comparator === "count_and_calendar_cap" && option.numberOfPayments > months) reject("OPTION_MAX_INSTALLMENT_COUNT", "Conservative duration policy bounds payment count by allowed months", "number_of_payments");
        const start = state.request.date, parts = start.calendarParts();
        // A 90-date horizon fits within three anchored calendar months. Large
        // supplied caps need no unsafe integer coercion or out-of-range date.
        if (months < 3n) {
          try {
            if (last.compare(start.addCalendarMonths(Number(months), parts.day, start.isMonthEnd())) > 0) reject("OPTION_MAX_INSTALLMENT_DURATION", "Last payment exceeds request-anchored calendar month cap", "first_payment_date");
          } catch { reject("OPTION_DATE_RANGE", "Calendar duration cap lies outside supported Gregorian date range", "first_payment_date"); }
        }
      }
    }
  }
  const payments: DatedPayment[] = [];
  if (issues.length === 0) for (let index = 0n; index < option.numberOfPayments; index++) payments.push(Object.freeze({ date: option.firstPaymentDate.addDays(Number(index * (option.paymentFrequencyDays ?? 0n))), amount: option.paymentAmount }));
  return Object.freeze({ payments: issues.length === 0 ? Object.freeze(payments) : null, issues: sortIssues(issues) as readonly PlanIssue[] });
}
