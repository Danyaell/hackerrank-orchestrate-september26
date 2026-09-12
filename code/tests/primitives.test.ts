import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Decimal } from "decimal.js";
import { Money, MoneyError } from "../src/core/money.js";
import { DateOnly } from "../src/core/dates.js";
import { FxIndex } from "../src/core/fx.js";
import type { Currency, ExchangeRate, Provenance, RecordWithSource } from "../src/domain.js";

const m = (text: string, currency: Currency = "INR") => Money.fromDecimalString(text, currency);
const source: Provenance = Object.freeze({ filename: "financial_events.csv", row: 3, recordId: "synthetic-cash" });
function rate(text = "1.2345", date = "2025-07-02", from: Currency = "USD", to: Currency = "INR", row = 1): RecordWithSource<ExchangeRate> {
  return Object.freeze({
    data: Object.freeze({ rate_date: date, from_currency: from, to_currency: to, rate: text }),
    source: Object.freeze({ filename: "exchange_rates.csv", row, recordId: null }),
  });
}

test("0.1 plus 0.2 is exactly 0.3 and operands are unchanged", () => {
  const left = m("0.1");
  assert.equal(left.add(m("0.2")).toExactDecimalString(), "0.3");
  assert.equal(left.toExactDecimalString(), "0.1");
});
test("large and tiny operands retain precision beyond Decimal's default", () => {
  const large = "1" + "0".repeat(80);
  const small = "0." + "0".repeat(80) + "1";
  const mixed = large + "." + "0".repeat(80) + "1";
  assert.equal(m(large).add(m(small)).toExactDecimalString(), mixed);
  assert.equal(m(mixed).subtract(m(large)).toExactDecimalString(), small);
  assert.equal(m(small).multiplyByRate("0.1").toExactDecimalString(), "0." + "0".repeat(81) + "1");
});
test("every two-money operation rejects a currency mismatch", () => {
  const a = m("1", "INR"), b = m("1", "USD");
  for (const operation of [() => a.add(b), () => a.subtract(b), () => a.compare(b), () => a.minimum(b), () => a.maximum(b), () => a.equals(b)]) {
    assert.throws(operation, (error) => error instanceof MoneyError && error.code === "CURRENCY_MISMATCH");
  }
});
test("signed debit amounts, subtraction, comparisons, minimum and maximum", () => {
  assert.equal(m("100").negate().toExactDecimalString(), "-100");
  assert.equal(m("1").subtract(m("2")).toExactDecimalString(), "-1");
  assert.equal(m("-2").minimum(m("-1")).toExactDecimalString(), "-2");
  assert.equal(m("-2").maximum(m("-1")).toExactDecimalString(), "-1");
  assert.ok(m("1.00").equals(m("1")));
  assert.throws(() => Money.fromNonNegativeDecimalString("-1", "INR"), /forbids negative/);
});
test("exact decimal rate multiplication is unrounded", () => {
  assert.equal(m("12.345").multiplyByRate("1.2345").toExactDecimalString(), "15.2399025");
  const coefficient = "123456789012345678901234567890123456789";
  assert.equal(m(coefficient).multiplyByRate(coefficient).toExactDecimalString(), (BigInt(coefficient) * BigInt(coefficient)).toString());
});
test("floor rounding is explicit and conservative for both signs", () => {
  assert.equal(m("1.239").roundDownToScale(2).toExactDecimalString(), "1.23");
  assert.equal(m("-1.239").roundDownToScale(2).toExactDecimalString(), "-1.24");
  assert.equal(m("2.345").toFixedDecimalString(2, "half_even"), "2.34");
  assert.equal(m("2.355").toFixedDecimalString(2, "half_even"), "2.36");
  assert.throws(() => m("1").roundDownToScale(-1));
});
test("canonical zero never serializes negative zero", () => {
  for (const text of ["0", "0.00", "-0.000"]) {
    assert.equal(m(text).toExactDecimalString(), "0");
    assert.equal(m(text).negate().toFixedDecimalString(2, "floor"), "0.00");
  }
  assert.equal(m("-0.001").toFixedDecimalString(2, "half_even"), "0.00");
});
test("invalid decimals, floating-point input and missing values are rejected", () => {
  for (const value of ["NaN", "Infinity", "1e2", "-1e2", "", "+1", ".5", "1.", "1,000", " 1", null, undefined, 0.1]) {
    assert.throws(() => Money.fromDecimalString(value as string, "INR"));
  }
  assert.ok(Money.fromNonNegativeDecimalString("0", "INR").isZero());
  assert.throws(() => m("1").multiplyByRate("0"));
  assert.throws(() => m("1").multiplyByRate("-1"));
});
test("money boundary is immutable and rejects implicit coercion", () => {
  const value = m("0001.2300");
  assert.ok(Object.isFrozen(value));
  assert.deepEqual(value.serializeExact(), { amount: "1.23", currency: "INR" });
  assert.ok(Object.isFrozen(value.serializeExact()));
  assert.throws(() => value.valueOf());
  assert.ok(Object.values(value).every((item) => !(item instanceof Decimal)));
});
test("external Decimal precision changes cannot truncate money operations", () => {
  const precision = Decimal.precision;
  try {
    Decimal.set({ precision: 2 });
    assert.equal(m("123456789.123456789").add(m("0.000000001")).toExactDecimalString(), "123456789.12345679");
  } finally { Decimal.set({ precision }); }
});

test("Gregorian dates validate leap years and invalid days", () => {
  assert.equal(DateOnly.parse("2000-02-29").toISODateString(), "2000-02-29");
  for (const value of ["1900-02-29", "2026-02-30", "0000-01-01", "2025-13-01", "2025-01-00", "01/02/2025"]) assert.throws(() => DateOnly.parse(value));
});
test("whole-day arithmetic crosses leap, month and year boundaries", () => {
  const date = DateOnly.parse("2024-02-28");
  assert.equal(date.addDays(1).toISODateString(), "2024-02-29");
  assert.equal(date.addDays(2).toISODateString(), "2024-03-01");
  assert.equal(date.subtractDays(28).toISODateString(), "2024-01-31");
  assert.equal(DateOnly.parse("2025-12-31").addDays(1).toISODateString(), "2026-01-01");
  assert.equal(DateOnly.parse("2024-01-01").differenceInDays(DateOnly.parse("2023-01-01")), 365);
  assert.equal(DateOnly.parse("2025-01-01").differenceInDays(DateOnly.parse("2024-01-01")), 366);
});
test("date comparison, equality and boundary relations are deterministic", () => {
  const date = DateOnly.parse("2025-08-01");
  assert.ok(date.equals(DateOnly.parse("2025-08-01")));
  assert.equal(date.relationTo(date), "on");
  assert.equal(date.addDays(1).relationTo(date), "after");
  assert.equal(date.subtractDays(1).relationTo(date), "before");
  assert.equal(date.addDays(1).differenceInDays(date), 1);
  assert.throws(() => date.addDays(0.5));
  assert.throws(() => DateOnly.parse("0001-01-01").subtractDays(1));
  assert.throws(() => DateOnly.parse("9999-12-31").addDays(1));
});
test("date arithmetic is independent of machine timezone", () => {
  const moduleUrl = new URL("../src/core/dates.js", import.meta.url).href;
  const program = "import {DateOnly} from " + JSON.stringify(moduleUrl) + '; console.log(DateOnly.parse("2024-03-01").subtractDays(1).toISODateString());';
  for (const TZ of ["UTC", "Pacific/Kiritimati", "America/Mexico_City"]) {
    const cli = spawnSync(process.execPath, ["--input-type=module", "-e", program], { env: { ...process.env, TZ }, encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.trim(), "2024-02-29");
  }
});

test("directed FX uses settlement date and preserves both provenances", () => {
  const chosen = rate();
  const fx = new FxIndex([rate("2", "2025-07-01"), chosen]);
  const result = fx.convert(m("12.345", "USD"), "INR", DateOnly.parse("2025-07-02"), source);
  assert.deepEqual(result.issues, []);
  assert.equal(result.conversion!.converted.toExactDecimalString(), "15.2399025");
  assert.equal(result.conversion!.original.currency, "USD");
  assert.equal(result.conversion!.converted.currency, "INR");
  assert.equal(result.conversion!.source, source);
  assert.equal(result.conversion!.rateSource, chosen.source);
  assert.equal(result.conversion!.rateDate!.toISODateString(), "2025-07-02");
  assert.equal(result.conversion!.rate, "1.2345");
});
test("same-currency FX is exact passthrough without date or rate", () => {
  const original = m("1.0000000000000000000001");
  const result = new FxIndex([]).convert(original, "INR", null, source);
  assert.equal(result.conversion!.converted, original);
  assert.equal(result.conversion!.rate, null);
  assert.equal(result.conversion!.rateSource, null);
});
test("missing rates fail without live, nearest-date or request-date fallback", () => {
  const fx = new FxIndex([rate()]);
  const result = fx.convert(m("1", "USD"), "INR", DateOnly.parse("2025-07-03"), source);
  assert.equal(result.conversion, null);
  assert.equal(result.issues[0]!.code, "FX_MISSING_RATE");
  assert.equal(result.issues[0]!.recordId, source.recordId);
});
test("reverse-only FX does not derive a reciprocal", () => {
  const result = new FxIndex([rate("1", "2025-07-02", "INR", "USD")])
    .convert(m("1", "USD"), "INR", DateOnly.parse("2025-07-02"), source);
  assert.equal(result.conversion, null);
  assert.equal(result.issues[0]!.code, "FX_WRONG_DIRECTION");
});
test("duplicate FX keys are errors even when their numeric rates agree", () => {
  const fx = new FxIndex([rate("1"), rate("1.00", "2025-07-02", "USD", "INR", 2)]);
  assert.equal(fx.issues[0]!.code, "FX_DUPLICATE_RATE");
  assert.equal(fx.convert(m("1", "USD"), "INR", DateOnly.parse("2025-07-02"), source).issues[0]!.code, "FX_NON_UNIQUE_RATE");
});
test("conflicting FX keys are errors and no rate is selected", () => {
  const fx = new FxIndex([rate("1"), rate("2", "2025-07-02", "USD", "INR", 2)]);
  assert.equal(fx.issues[0]!.code, "FX_CONFLICTING_RATE");
  assert.equal(fx.convert(m("1", "USD"), "INR", DateOnly.parse("2025-07-02"), source).conversion, null);
});
test("foreign FX requires settlement date even if other rates exist", () => {
  const result = new FxIndex([rate()]).convert(m("1", "USD"), "INR", null, source);
  assert.equal(result.issues[0]!.code, "FX_MISSING_SETTLEMENT_DATE");
  assert.equal(result.issues[0]!.field, "settlement_date");
});
