import { Decimal } from "decimal.js";
import { currencies } from "../schemas.js";
import type { Currency } from "../domain.js";
const Base = Decimal.clone({ maxE: 9_000_000_000_000_000, minE: -9_000_000_000_000_000 });

export class MoneyError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function validated(value: string, nonNegative: boolean): string {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value)) {
    throw new MoneyError("INVALID_DECIMAL", "Expected a finite plain decimal string");
  }
  if (nonNegative && value.startsWith("-")) throw new MoneyError("NEGATIVE_AMOUNT", "This field forbids negative amounts");
  const result = new Base(value);
  return result.isZero() ? "0" : result.toFixed();
}
function dimensions(value: string): { integer: number; fraction: number; digits: number } {
  const [integer = "", fraction = ""] = value.replace("-", "").split(".");
  return { integer: integer.length, fraction: fraction.length, digits: integer.length + fraction.length };
}

/** Immutable string boundary; Decimal objects are local to individual operations. */
export class Money {
  readonly #text: string;
  private constructor(text: string, readonly currency: Currency) {
    if (!currencies.includes(currency)) throw new MoneyError("INVALID_CURRENCY", "Unsupported currency");
    this.#text = text;
    Object.freeze(this);
  }
  static fromDecimalString(value: string, currency: Currency): Money {
    return new Money(validated(value, false), currency);
  }
  static fromNonNegativeDecimalString(value: string, currency: Currency): Money {
    return new Money(validated(value, true), currency);
  }
  private sameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new MoneyError("CURRENCY_MISMATCH", "Arithmetic requires matching currencies");
  }
  private arithmetic(other: string, operation: "add" | "subtract" | "multiply"): Money {
    const a = dimensions(this.#text);
    const b = dimensions(other);
    const precision = operation === "multiply" ? a.digits + b.digits + 2 :
      Math.max(a.integer, b.integer) + Math.max(a.fraction, b.fraction) + 2;
    if (precision > 1_000_000_000) throw new MoneyError("PRECISION_LIMIT", "Exact operation exceeds Decimal's supported precision");
    const Exact = Decimal.clone({ precision, maxE: 9_000_000_000_000_000, minE: -9_000_000_000_000_000 });
    const left = new Exact(this.#text);
    const result = operation === "add" ? left.plus(other) : operation === "subtract" ? left.minus(other) : left.times(other);
    return Money.fromDecimalString(result.toFixed(), this.currency);
  }
  add(other: Money): Money { this.sameCurrency(other); return this.arithmetic(other.#text, "add"); }
  subtract(other: Money): Money { this.sameCurrency(other); return this.arithmetic(other.#text, "subtract"); }
  compare(other: Money): -1 | 0 | 1 {
    this.sameCurrency(other);
    const result = new Base(this.#text).comparedTo(other.#text);
    return result < 0 ? -1 : result > 0 ? 1 : 0;
  }
  equals(other: Money): boolean { return this.compare(other) === 0; }
  minimum(other: Money): Money { return this.compare(other) <= 0 ? this : other; }
  maximum(other: Money): Money { return this.compare(other) >= 0 ? this : other; }
  negate(): Money { return Money.fromDecimalString(new Base(this.#text).negated().toFixed(), this.currency); }
  multiplyByRate(rate: string): Money {
    const exactRate = validated(rate, true);
    if (exactRate === "0") throw new MoneyError("INVALID_RATE", "A rate must be positive");
    return this.arithmetic(exactRate, "multiply");
  }
  isZero(): boolean { return this.#text === "0"; }
  toExactDecimalString(): string { return this.#text; }
  serializeExact(): Readonly<{ amount: string; currency: Currency }> {
    return Object.freeze({ amount: this.#text, currency: this.currency });
  }
  /** Conservative floor, including negative values; not truncation toward zero. */
  roundDownToScale(scale: number): Money {
    this.validateScale(scale);
    return Money.fromDecimalString(new Base(this.#text).toDecimalPlaces(scale, Decimal.ROUND_FLOOR).toFixed(), this.currency);
  }
  toFixedDecimalString(scale: number, rounding: "floor" | "half_even"): string {
    this.validateScale(scale);
    if (rounding !== "floor" && rounding !== "half_even") throw new MoneyError("INVALID_ROUNDING", "Rounding mode must be explicit and supported");
    const mode = rounding === "floor" ? Decimal.ROUND_FLOOR : Decimal.ROUND_HALF_EVEN;
    const rounded = new Base(this.#text).toDecimalPlaces(scale, mode);
    return (rounded.isZero() ? new Base("0") : rounded).toFixed(scale);
  }
  private validateScale(scale: number): void {
    if (!Number.isSafeInteger(scale) || scale < 0 || scale > 1_000_000_000) throw new MoneyError("INVALID_SCALE", "Scale must be a supported non-negative integer");
  }
  valueOf(): never { throw new MoneyError("IMPLICIT_COERCION", "Use an explicit money serialization method"); }
}
