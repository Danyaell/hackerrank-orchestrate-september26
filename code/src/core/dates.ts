import { isDateOnly } from "../schemas.js";

const beforeYear = (year: number): number => {
  const prior = year - 1;
  return 365 * prior + Math.floor(prior / 4) - Math.floor(prior / 100) + Math.floor(prior / 400);
};
const monthLengths = (year: number): readonly number[] =>
  [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Integer Gregorian ordinals; no JS Date, timezone, clock or locale parsing. */
export class DateOnly {
  readonly #text: string;
  readonly #ordinal: number;
  private constructor(text: string, ordinal: number) { this.#text = text; this.#ordinal = ordinal; Object.freeze(this); }
  static parse(value: string): DateOnly {
    if (typeof value !== "string" || !isDateOnly(value)) throw new Error("Invalid Gregorian YYYY-MM-DD date");
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const priorMonths = monthLengths(year).slice(0, month - 1).reduce((sum, days) => sum + days, 0);
    return new DateOnly(value, beforeYear(year) + priorMonths + day - 1);
  }
  compare(other: DateOnly): -1 | 0 | 1 { return this.#ordinal < other.#ordinal ? -1 : this.#ordinal > other.#ordinal ? 1 : 0; }
  equals(other: DateOnly): boolean { return this.compare(other) === 0; }
  relationTo(other: DateOnly): "before" | "on" | "after" {
    return this.compare(other) < 0 ? "before" : this.compare(other) > 0 ? "after" : "on";
  }
  differenceInDays(other: DateOnly): number { return this.#ordinal - other.#ordinal; }
  addDays(days: number): DateOnly {
    if (!Number.isSafeInteger(days)) throw new Error("Day offset must be a safe integer");
    const target = this.#ordinal + days;
    if (target < 0 || target >= beforeYear(10000)) throw new Error("Date outside supported Gregorian years 0001–9999");
    let low = 1;
    let high = 10000;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (beforeYear(middle) <= target) low = middle; else high = middle;
    }
    let remainder = target - beforeYear(low);
    let month = 1;
    for (const length of monthLengths(low)) {
      if (remainder < length) break;
      remainder -= length;
      month++;
    }
    return DateOnly.parse(String(low).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(remainder + 1).padStart(2, "0"));
  }
  subtractDays(days: number): DateOnly { return this.addDays(-days); }
  calendarParts(): Readonly<{ year: number; month: number; day: number }> {
    return Object.freeze({ year: Number(this.#text.slice(0, 4)), month: Number(this.#text.slice(5, 7)), day: Number(this.#text.slice(8, 10)) });
  }
  isMonthEnd(): boolean { const { year, month, day } = this.calendarParts(); return day === monthLengths(year)[month - 1]; }
  /** Caller retains the original anchor; clipping a short month never changes it. */
  addCalendarMonths(months: number, anchorDay: number, monthEnd = false): DateOnly {
    if (!Number.isSafeInteger(months) || !Number.isSafeInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) throw new Error("Invalid calendar month offset or anchor");
    const parts = this.calendarParts();
    const index = (parts.year - 1) * 12 + parts.month - 1 + months;
    if (!Number.isSafeInteger(index) || index < 0 || index >= 9999 * 12) throw new Error("Date outside supported Gregorian years 0001–9999");
    const year = Math.floor(index / 12) + 1;
    const month = index % 12 + 1;
    const length = monthLengths(year)[month - 1]!;
    const day = monthEnd ? length : Math.min(anchorDay, length);
    return DateOnly.parse(String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0"));
  }
  toISODateString(): string { return this.#text; }
  valueOf(): never { throw new Error("Use explicit date comparison or serialization"); }
}
