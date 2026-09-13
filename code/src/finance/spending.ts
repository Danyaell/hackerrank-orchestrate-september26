import { planPolicy, sortIssues } from "../config.js";
import { Money } from "../core/money.js";
import type { FxIndex } from "../core/fx.js";
import type { FinancialForecast, FinancialState, PlanIssue, RecurrenceResult, SpendingAction } from "../domain.js";
import { planIssue } from "./options.js";
import { movementId } from "./forecast.js";

const permits = (list: string, category: string): boolean => list.split("|").includes(category);
export const actionText = (action: SpendingAction): string => action.kind + ":" + action.anchorEventId + (action.kind === "reduce_to" ? ":" + action.amount!.toExactDecimalString() : "");

export function validateAction(state: FinancialState, forecast: FinancialForecast, recurrence: RecurrenceResult, action: SpendingAction): readonly PlanIssue[] {
  const issues: PlanIssue[] = [], series = recurrence.series.find((value) => value.id === action.seriesId);
  const reject = (code: string, explanation: string): void => { issues.push(planIssue(code, "eligibility", action.provenance[0] ?? state.request.source, explanation, "spending_change", null, null, action.seriesId)); };
  const records = series?.supportingEventIds.map((id) => state.records.find((record) => record.event.id === id)).filter((record) => record !== undefined) ?? [];
  if (!series || series.userId !== state.request.userId || series.direction !== "debit" || series.eventType !== "expense" || series.status !== "active" || !["supported", "strong"].includes(series.support) || series.observationCount < 3 || records.length !== series.supportingEventIds.length || records.some((record) => record.category !== "historical_settled" || record.event.status !== "settled" || record.event.amount.kind !== "resolved" || record.conversion === null || record.unresolvedReasons.length > 0 || record.event.settlementDate === null || record.event.settlementDate.compare(state.request.date) >= 0)) {
    reject("CHANGE_UNSUPPORTED_SERIES", "Action requires an active supported owned recurring expense"); return issues;
  }
  const ordered = [...records].sort((a, b) => a.event.settlementDate!.compare(b.event.settlementDate!) || a.event.eventDate.compare(b.event.eventDate) || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0));
  if (action.anchorEventId !== ordered.at(-1)!.event.id) reject("CHANGE_ANCHOR", "Anchor must be the latest deterministic supporting event");
  if (permits(state.profile.raw.expense_categories_to_protect, series.category)) reject("CHANGE_PROTECTED", "Protected expense category cannot change");
  const authorized = action.kind === "stop" ? state.profile.raw.expense_categories_user_is_willing_to_stop : state.profile.raw.expense_categories_user_is_willing_to_reduce;
  if (!permits(authorized, series.category)) reject("CHANGE_UNAUTHORIZED", "User has not permitted this action for the category");
  if (records.some((record) => ![action.kind === "stop" ? "stoppable" : "reducible", "reducible_or_stoppable"].includes(record.event.raw.flexibility))) reject("CHANGE_FLEXIBILITY", "Underlying flexibility does not permit this action");
  const affected = forecast.movements.filter((movement) => movement.kind === "generated_recurring_expense" && movement.seriesId === series.id && movement.date.compare(state.request.date) > 0);
  if (affected.length === 0) reject("CHANGE_NO_FUTURE_EFFECT", "No future generated occurrence exists strictly after the request date");
  if (action.kind === "stop") {
    if (action.amount !== null) reject("CHANGE_STOP_AMOUNT", "Stop action must not carry a reduction amount");
  } else if (action.kind === "reduce_to") {
    const floorRecords = records.map((record) => record.event.minimumAllowedAmount);
    if (floorRecords.some((amount) => amount === null)) reject("CHANGE_MISSING_FLOOR", "Reduction floor is absent; no minimum or zero was invented");
    const amount = action.amount;
    if (amount === null || amount.currency !== series.currency || amount.compare(Money.fromDecimalString("0", series.currency)) < 0) reject("CHANGE_REDUCTION_AMOUNT", "Reduction requires a reported nonnegative source-currency amount; a missing floor is not zero");
    else {
      const floors = floorRecords.filter((value) => value !== null);
      if (floors.some((value) => value.currency !== series.currency || amount.compare(value) < 0)) reject("CHANGE_MINIMUM_FLOOR", "Reduction is below a supplied supporting minimum");
      if (affected.some((movement) => amount.compare(movement.original) >= 0)) reject("CHANGE_NOT_REDUCTION", "Reduction must strictly lower every affected source amount");
    }
  } else reject("CHANGE_KIND", "Unsupported action kind");
  return sortIssues(issues) as readonly PlanIssue[];
}

export function availableActions(state: FinancialState, forecast: FinancialForecast, recurrence: RecurrenceResult): { readonly actions: readonly SpendingAction[]; readonly issues: readonly PlanIssue[] } {
  const actions: SpendingAction[] = [], issues: PlanIssue[] = [];
  for (const series of recurrence.series.filter((value) => value.direction === "debit" && value.eventType === "expense" && value.status === "active")) {
    const records = series.supportingEventIds.map((id) => state.records.find((record) => record.event.id === id)!).filter(Boolean);
    if (records.length === 0 || records.every((record) => record.event.raw.flexibility === "fixed")) continue;
    const latest = [...records].sort((a, b) => a.event.settlementDate!.compare(b.event.settlementDate!) || a.event.eventDate.compare(b.event.eventDate) || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0)).at(-1)!;
    const floors = records.map((record) => record.event.minimumAllowedAmount).filter((value) => value !== null);
    for (const kind of ["stop", "reduce_to"] as const) {
      const amount = kind === "stop" || floors.length !== records.length ? null : floors.reduce((a, b) => a.maximum(b));
      const action: SpendingAction = Object.freeze({ kind, anchorEventId: latest.event.id, seriesId: series.id, amount, provenance: series.provenance });
      const rejected = validateAction(state, forecast, recurrence, action);
      if (rejected.length === 0) actions.push(action); else issues.push(...rejected);
    }
  }
  return Object.freeze({ actions: Object.freeze(actions.sort((a, b) => actionText(a) < actionText(b) ? -1 : actionText(a) > actionText(b) ? 1 : 0)), issues: sortIssues(issues) as readonly PlanIssue[] });
}

/** Exact floor reductions dominate higher reductions on the same series; both
 * stop and reduce remain when permitted, with all compatible sets retained. */
export function actionSets(actions: readonly SpendingAction[]): readonly (readonly SpendingAction[])[] {
  const sets: (readonly SpendingAction[])[] = [Object.freeze([])];
  const expand = (start: number, prefix: readonly SpendingAction[]): void => {
    if (prefix.length === planPolicy.maxChanges) return;
    for (let index = start; index < actions.length; index++) {
      const action = actions[index]!;
      if (prefix.some((value) => value.seriesId === action.seriesId || value.anchorEventId === action.anchorEventId)) continue;
      const next = Object.freeze([...prefix, action]); sets.push(next); expand(index + 1, next);
    }
  };
  expand(0, []); return Object.freeze(sets);
}

export function applySpending(state: FinancialState, forecast: FinancialForecast, recurrence: RecurrenceResult, changes: readonly SpendingAction[], fx: FxIndex): {
  readonly forecast: FinancialForecast; readonly issues: readonly PlanIssue[]; readonly changedMovementIds: readonly string[];
} {
  const issues: PlanIssue[] = [];
  if (changes.length > planPolicy.maxChanges) issues.push(planIssue("CHANGE_LIMIT", "eligibility", state.request.source, "At most three spending actions are allowed", "spending_change"));
  const seen = new Set<string>(), anchors = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.seriesId) || anchors.has(change.anchorEventId)) issues.push(planIssue("CHANGE_CONFLICT", "eligibility", state.request.source, "Stop and reduction or duplicate actions cannot target the same series/event", "spending_change", null, null, change.seriesId));
    seen.add(change.seriesId); anchors.add(change.anchorEventId); issues.push(...validateAction(state, forecast, recurrence, change));
  }
  const changedMovementIds: string[] = [];
  if (issues.length > 0) return { forecast, issues: sortIssues(issues) as readonly PlanIssue[], changedMovementIds };
  const movements = forecast.movements.flatMap((movement) => {
    const change = changes.find((value) => value.seriesId === movement.seriesId);
    if (!change || movement.kind !== "generated_recurring_expense" || movement.date.compare(state.request.date) <= 0) return [movement];
    changedMovementIds.push(movement.id);
    if (change.kind === "stop") return [];
    const conversion = fx.convert(change.amount!, state.profile.homeCurrency, movement.date, change.provenance[0]!);
    if (conversion.conversion === null) {
      issues.push(planIssue("CHANGE_FX_UNRESOLVED", "input", change.provenance[0]!, "Changed foreign expense lacks valid dated directed conversion", "currency", null, null, change.seriesId)); return [movement];
    }
    return [Object.freeze({ ...movement, id: movementId("change", movement.id, actionText(change)), original: change.amount!, amount: conversion.conversion.converted.negate(), fx: conversion.conversion })];
  });
  return Object.freeze({ forecast: Object.freeze({ ...forecast, movements: Object.freeze(movements) }), issues: sortIssues(issues) as readonly PlanIssue[], changedMovementIds: Object.freeze(changedMovementIds) });
}
