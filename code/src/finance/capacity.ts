import { forecastPolicy, sortIssues } from "../config.js";
import { Money } from "../core/money.js";
import { simulate } from "./simulate.js";
import type { BaselineCapacity, FinancialForecast, FinancialState, SimulationTrace } from "../domain.js";

/** No preference, offer, completion deadline, spending change or plan enters this API. */
export function calculateCapacity(state: FinancialState, forecast: FinancialForecast): BaselineCapacity {
  const pending = state.pendingBalancePolicy === "unknown" ? forecastPolicy.pendingScenarios : [state.pendingBalancePolicy];
  const traces: SimulationTrace[] = [];
  for (const pendingScenario of pending) for (const ordering of forecastPolicy.sameDayScenarios) traces.push(simulate(state, forecast, pendingScenario, ordering));
  const limiting = traces.reduce((worst, trace) => trace.minimumBalance.compare(worst.minimumBalance) < 0 ? trace : worst, traces[0]!);
  const issues = sortIssues([...forecast.issues, ...traces.flatMap((trace) => trace.issues)]);
  const blocked = issues.some((issue) => issue.severity === "error");
  const unresolved = forecast.issues.some((issue) => issue.effect === "conservative_unresolved");
  const unsafe = traces.some((trace) => trace.breaches.length > 0);
  let status: BaselineCapacity["status"] = blocked ? "blocked" : unresolved ? "conservative_unresolved" : unsafe ? "unsafe" : "valid";
  let maximumImmediatePayment: Money | null = null, earliestFullPaymentDate: BaselineCapacity["earliestFullPaymentDate"] = null;
  if (status === "valid") {
    // Injection shifts every later checkpoint by the same exact amount. Full
    // simulation below verifies the headroom identity rather than assuming it.
    maximumImmediatePayment = limiting.minimumBalance.subtract(state.profile.minimumBalance);
    const boundary = { id: "capacity-boundary", date: state.request.date, amount: maximumImmediatePayment.negate(), source: state.request.source };
    if (traces.some((trace) => {
      const verified = simulate(state, forecast, trace.pendingScenario, trace.sameDayOrder, [boundary]);
      return verified.issues.length > 0 || verified.breaches.length > 0;
    })) {
      status = "blocked"; maximumImmediatePayment = null;
    } else {
      // An inserted debit permanently reduces every later spendable checkpoint.
      // A suffix below its amount proves a date unsafe without cloning a trace;
      // every remaining candidate is still verified by full injected simulation.
      const suffixMargins = traces.map((trace) => {
        const values = new Map<string, Money>(); let margin: Money | null = null;
        for (const day of [...trace.days].reverse()) {
          const daily = day.minimumBalance.subtract(state.profile.minimumBalance);
          margin = margin === null ? daily : margin.minimum(daily);
          values.set(day.date.toISODateString(), margin);
        }
        return values;
      });
      for (let date = forecast.start; date.compare(forecast.end) <= 0; ) {
        const payment = { id: "full-capacity-probe", date, amount: state.request.amount.negate(), source: state.request.source };
        const possible = suffixMargins.every((values) => values.get(date.toISODateString())!.compare(state.request.amount) >= 0);
        if (possible && traces.every((trace) => { const result = simulate(state, forecast, trace.pendingScenario, trace.sameDayOrder, [payment]); return result.issues.length === 0 && result.breaches.length === 0; })) {
          earliestFullPaymentDate = date; break;
        }
        if (date.equals(forecast.end)) break;
        date = date.addDays(1);
      }
    }
  }
  const signature = (trace: SimulationTrace): string => trace.checkpoints.map((point) => point.date.toISODateString() + ":" + point.phase + ":" + point.movement?.id + ":" + point.spendableBalance.toExactDecimalString()).join("|");
  const pendingSensitive = traces.some((a) => traces.some((b) => a.sameDayOrder === b.sameDayOrder && a.pendingScenario !== b.pendingScenario && signature(a) !== signature(b)));
  const dailyMinimums = (trace: SimulationTrace): string => trace.days.map((day) => day.minimumBalance.toExactDecimalString()).join("|");
  const sameDaySensitive = traces.some((a) => traces.some((b) => a.pendingScenario === b.pendingScenario && a.sameDayOrder !== b.sameDayOrder && dailyMinimums(a) !== dailyMinimums(b)));
  const finalIssues = status === "blocked" && !blocked ? sortIssues([...issues, { ...state.request.source, severity: "error", code: "CAPACITY_BOUNDARY_INVARIANT", field: "amount", explanation: "Injected exact headroom failed full checkpoint verification" }]) : issues;
  return Object.freeze({ status, maximumImmediatePayment, earliestFullPaymentDate, baselineTraces: Object.freeze(traces), limitingScenario: limiting.pendingScenario + "/" + limiting.sameDayOrder,
    limitingCheckpoint: limiting.minimumCheckpoint, margin: limiting.minimumCheckpoint.margin, issues: finalIssues, pendingSensitive, sameDaySensitive });
}
