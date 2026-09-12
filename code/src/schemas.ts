import { z } from "zod";

export const currencies = ["INR", "ZAR", "IDR", "USD", "EUR"] as const;
export const categories = [
  "cloud_storage", "debt_repayment", "delivery_membership", "dining",
  "education", "entertainment", "family_support", "groceries", "gym",
  "healthcare", "housing", "insurance", "investment", "music_subscription",
  "rent", "salary", "shopping", "streaming", "transport", "utilities",
  "windfall", "work_expense",
] as const;
export const id = z.string().refine((value) => value.trim().length > 0, "Required non-empty identifier");
export const decimal = z.string().regex(/^\d+(?:\.\d+)?$/, "Expected an unsigned plain decimal string");
export const optionalDecimal = z.union([z.literal("").transform(() => null), decimal]);
export const optionalReference = z.union([z.literal("").transform(() => null), id]);
const positiveInteger = z.string().regex(/^[1-9]\d*$/, "Expected a positive integer string");
const optionalInteger = z.union([z.literal("").transform(() => null), positiveInteger]);

export function isDateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}

export const dateOnly = z.string().refine(isDateOnly, "Expected a valid Gregorian YYYY-MM-DD date");
const optionalDate = z.union([z.literal("").transform(() => null), dateOnly]);
const timestamp = z.iso.datetime({ offset: true }).refine(
  (value) => isDateOnly(value.slice(0, 10)), "Expected a valid Gregorian timestamp",
);
const text = z.string().refine((value) => value.trim().length > 0, "Required non-empty text");
const currency = z.enum(currencies);
const pipeList = (values: readonly string[], allowEmpty: boolean) =>
  z.string().refine((value) => {
    if (value === "") return allowEmpty;
    const items = value.split("|");
    return new Set(items).size === items.length && items.every((item) => values.includes(item));
  }, "Expected a pipe-separated list of distinct allowed values");

export const requestSchema = z.strictObject({
  request_id: id,
  user_id: id,
  request_date: dateOnly,
  request_type: z.enum(["purchase", "travel", "education", "family_transfer", "debt_repayment", "investment", "housing", "emergency_expense", "other"]),
  requested_amount: decimal,
  desired_completion_date: dateOnly,
  allows_partial_payment: z.enum(["true", "false"]).transform((value) => value === "true"),
  request_text: text,
});
export const profileSchema = z.strictObject({
  user_id: id,
  home_currency: currency,
  current_available_balance: decimal,
  minimum_balance_to_keep: decimal,
  financial_priorities: pipeList(["debt_repayment", "education", "emergency_savings", "family_support", "healthcare", "housing", "retirement_investment", "travel"], false),
  expense_categories_to_protect: pipeList(categories, true),
  expense_categories_user_is_willing_to_reduce: pipeList(categories, true),
  expense_categories_user_is_willing_to_stop: pipeList(categories, true),
  payment_methods_user_will_consider: pipeList(["full_payment", "partial_payment", "installments"], false),
  max_installment_months: optionalInteger,
});
export const eventSchema = z.strictObject({
  event_id: id,
  user_id: id,
  event_type: z.enum(["expense", "subscription", "income", "debt_payment", "investment_purchase", "refund", "investment_valuation", "investment_sale"]),
  description: text,
  category: z.enum(categories),
  direction: z.enum(["debit", "credit", "non_cash"]),
  amount: optionalDecimal,
  currency,
  event_date: dateOnly,
  settlement_date: optionalDate,
  status: z.enum(["settled", "pending", "scheduled", "cancelled", "failed", "unrealized"]),
  linked_event_id: optionalReference,
  flexibility: z.enum(["fixed", "reducible", "stoppable", "reducible_or_stoppable"]),
  minimum_allowed_amount: optionalDecimal,
});
export const paymentOptionSchema = z.strictObject({
  payment_option_id: id,
  request_id: id,
  payment_method: z.enum(["full_payment", "installments"]),
  payment_amount: decimal,
  number_of_payments: positiveInteger,
  first_payment_date: dateOnly,
  payment_frequency_days: optionalInteger,
  financing_fee: decimal,
  total_payable_amount: decimal,
});
export const messageSchema = z.strictObject({
  message_id: id,
  user_id: id,
  request_id: optionalReference,
  related_event_id: optionalReference,
  sent_at: timestamp,
  source_type: z.enum(["employer", "service_provider", "financial_service", "bank", "merchant"]),
  message_text: text,
});
export const imageSchema = z.strictObject({
  image_id: id,
  user_id: id,
  request_id: optionalReference,
  related_event_id: optionalReference,
});
export const exchangeRateSchema = z.strictObject({
  rate_date: dateOnly,
  from_currency: currency,
  to_currency: currency,
  rate: decimal.refine((value) => /[1-9]/.test(value), "Rate must be greater than zero"),
});

export const schemas = {
  requests: requestSchema,
  financial_profiles: profileSchema,
  financial_events: eventSchema,
  request_payment_options: paymentOptionSchema,
  messages: messageSchema,
  images: imageSchema,
  exchange_rates: exchangeRateSchema,
} as const;

export const headers = {
  requests: Object.keys(requestSchema.shape),
  financial_profiles: Object.keys(profileSchema.shape),
  financial_events: Object.keys(eventSchema.shape),
  request_payment_options: Object.keys(paymentOptionSchema.shape),
  messages: Object.keys(messageSchema.shape),
  images: Object.keys(imageSchema.shape),
  exchange_rates: Object.keys(exchangeRateSchema.shape),
} as const;
