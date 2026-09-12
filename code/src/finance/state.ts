import { sortIssues } from "../config.js";
import type {
  CanonicalEvent, CashFact, FinancialState, Issue, LifecycleEdge, LifecycleGroup,
  NormalizedData, PendingBalancePolicy, StateCategory, StateRecord, StateResult,
} from "../domain.js";

const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
function edgeKind(parent: CanonicalEvent, child: CanonicalEvent): LifecycleEdge["kind"] {
  if (parent.status === "cancelled" && parent.direction === "debit" && child.status === "settled" && child.direction === "debit") return "authorization_replacement";
  if (parent.status === "settled" && parent.direction === "debit" && child.type === "refund" && child.direction === "credit") {
    if (child.status === "settled") return "settled_refund";
    if (child.status === "pending") return "pending_refund";
  }
  if (parent.status === "failed" && parent.type === "debt_payment" && child.type === "debt_payment" &&
    parent.direction === "debit" && child.direction === "debit" && child.status === "scheduled") return "debt_retry";
  if (parent.type === "investment_purchase" && parent.direction === "debit") {
    if (child.type === "investment_valuation" && (child.status === "unrealized" || child.direction === "non_cash")) return "investment_valuation";
    if (child.type === "investment_sale" && child.status === "settled" && child.direction === "credit") return "investment_sale";
  }
  return "ambiguous";
}

/** Ledger presentation order is lexical ID order, never a same-day application policy. */
export function reconstructState(
  data: NormalizedData, requestId: string, pendingBalancePolicy: PendingBalancePolicy = "unknown",
): StateResult {
  const request = data.requests.get(requestId);
  if (!request) return { state: null, issues: sortIssues([...data.issues, {
    code: "UNKNOWN_REQUEST", severity: "error", filename: "requests.csv", row: null,
    field: "request_id", recordId: requestId, explanation: "Request is not in the active production request set",
  }]) };
  const profile = data.profiles.get(request.userId);
  if (!profile) return { state: null, issues: sortIssues([...data.issues, {
    ...request.source, code: "STATE_MISSING_PROFILE", severity: "error", field: "user_id", explanation: "Request has no normalized home-currency profile",
  }]) };
  const issues: Issue[] = [...data.issues];
  const events = data.events.filter((event) => event.userId === request.userId).sort((a, b) => compareIds(a.id, b.id));
  const add = (event: CanonicalEvent, code: string, field: string, explanation: string, severity: "warning" | "error" = "error"): void => {
    issues.push({ ...event.source, code, severity, field, explanation });
  };
  const byId = new Map<string, CanonicalEvent>();
  for (const event of events) {
    if (!byId.has(event.id)) byId.set(event.id, event);
    const bucket = data.eventBuckets.get(event.id)!;
    if (bucket.length > 1) {
      add(event, "DUPLICATE_EVENT_ID", "event_id", "Event identity is not unique");
      if (new Set(bucket.map((item) => item.linkedEventId)).size > 1) add(event, "MULTIPLE_LIFECYCLE_PARENTS", "linked_event_id", "A source event identity has conflicting parents");
    }
  }
  const edges: LifecycleEdge[] = [];
  const parentOf = new Map<string, string>();
  const adjacency = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.linkedEventId === null) continue;
    const bucket = data.eventBuckets.get(event.linkedEventId);
    if (!bucket) { add(event, "STATE_MISSING_EVENT_LINK", "linked_event_id", "Referenced lifecycle event is absent"); continue; }
    if (event.linkedEventId === event.id) { add(event, "SELF_EVENT_LINK", "linked_event_id", "Lifecycle self-link is invalid"); continue; }
    if (bucket.some((parent) => parent.userId !== event.userId)) { add(event, "CROSS_USER_EVENT_LINK", "linked_event_id", "Lifecycle link crosses user ownership"); continue; }
    if (bucket.length !== 1) { add(event, "AMBIGUOUS_EVENT_REFERENCE", "linked_event_id", "Referenced event identity is not unique"); continue; }
    const parent = bucket[0]!;
    const kind = edgeKind(parent, event);
    edges.push(Object.freeze({ earlierEventId: parent.id, laterEventId: event.id, kind }));
    parentOf.set(event.id, parent.id);
    for (const [left, right] of [[parent.id, event.id], [event.id, parent.id]] as const) {
      const neighbors = adjacency.get(left) ?? new Set<string>();
      neighbors.add(right);
      adjacency.set(left, neighbors);
    }
    if (kind === "ambiguous") add(event, "AMBIGUOUS_LIFECYCLE", "linked_event_id",
      "Link does not establish duplication, replacement or another supported lifecycle; both records remain distinct", "warning");
  }
  const processed = new Set<string>();
  for (const event of events) {
    let cursor: string | undefined = event.id;
    const path = new Set<string>();
    while (cursor !== undefined && !processed.has(cursor)) {
      if (path.has(cursor)) { add(byId.get(cursor)!, "CYCLIC_EVENT_LINK", "linked_event_id", "Lifecycle links contain a cycle"); break; }
      path.add(cursor);
      cursor = parentOf.get(cursor);
    }
    for (const id of path) processed.add(id);
  }
  const groups: LifecycleGroup[] = [];
  const grouped = new Set<string>();
  for (const event of events) {
    if (grouped.has(event.id) || !adjacency.has(event.id)) continue;
    const queue = [event.id];
    const members: string[] = [];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (grouped.has(id)) continue;
      grouped.add(id);
      members.push(id);
      queue.push(...(adjacency.get(id) ?? []));
    }
    members.sort(compareIds);
    const memberSet = new Set(members);
    const groupEdges = edges.filter((edge) => memberSet.has(edge.laterEventId))
      .sort((a, b) => compareIds(a.laterEventId, b.laterEventId));
    groups.push(Object.freeze({
      id: JSON.stringify(["lifecycle", ...members]), memberIds: Object.freeze(members),
      edges: Object.freeze(groupEdges), ambiguous: groupEdges.some((edge) => edge.kind === "ambiguous"),
    }));
  }

  const records: StateRecord[] = [];
  const ambiguousIds = new Set(groups.filter((group) => group.ambiguous).flatMap((group) => group.memberIds));
  const retriedDebtIds = new Set(edges.filter((edge) => edge.kind === "debt_retry").map((edge) => edge.earlierEventId));
  for (const event of events) {
    const unresolvedReasons: string[] = [];
    if (ambiguousIds.has(event.id)) unresolvedReasons.push("ambiguous_lifecycle");
    let category: StateCategory;
    if (event.status === "failed") {
      category = "failed";
      if (event.type === "debt_payment" && !retriedDebtIds.has(event.id)) {
        unresolvedReasons.push("failed_debt_without_confirmed_retry");
        add(event, "FAILED_DEBT_OBLIGATION_UNRESOLVED", "status",
          "Failed debt attempt has no supplied confirmed retry; underlying obligation remains uncertain", "warning");
      }
    }
    else if (event.status === "cancelled") category = "cancelled";
    else if (event.direction === "non_cash" || event.status === "unrealized") {
      category = "non_cash";
      if (event.status === "unrealized" && event.direction !== "non_cash") add(event, "UNREALIZED_DIRECTION_CONFLICT", "direction", "Unrealized record is non-cash despite its supplied direction", "warning");
    } else if (event.status === "pending") category = event.direction === "debit" ? "pending_debit" : "pending_credit";
    else if (event.settlementDate === null) {
      category = "ambiguous_obligation";
      unresolvedReasons.push("missing_settlement_date");
      add(event, "STATE_MISSING_SETTLEMENT_DATE", "settlement_date", "Settled or scheduled cash requires a supplied settlement date");
    } else {
      const relation = event.settlementDate.relationTo(request.date);
      if (event.status === "scheduled" && relation === "before") {
        category = "ambiguous_obligation";
        unresolvedReasons.push("overdue_schedule");
        add(event, "OVERDUE_SCHEDULED_EVENT", "settlement_date", "Past scheduled obligation is unresolved; no replacement date was invented", "warning");
      } else {
        category = relation === "before" ? "historical_settled" : relation === "after" ? "confirmed_future" : "same_day_dated";
        if (relation === "on" && event.status === "settled") {
          unresolvedReasons.push("same_day_snapshot");
          add(event, "SAME_DAY_SNAPSHOT_UNRESOLVED", "settlement_date", "Same-day settlement may already be in the snapshot; not replayed", "warning");
        }
      }
    }
    if (event.amount.kind === "unresolved") {
      unresolvedReasons.push("missing_amount");
      add(event, "UNRESOLVED_AMOUNT", "amount", "Amount remains absent; no zero cash movement was manufactured", "warning");
    }
    const requiresCashAmount = !["failed", "cancelled", "non_cash"].includes(category);
    let conversion = null;
    if (requiresCashAmount) {
      if (event.amount.kind === "resolved") {
        const result = data.fx.convert(event.amount.money, profile.homeCurrency, event.settlementDate, event.source);
        issues.push(...result.issues);
        conversion = result.conversion;
        if (conversion === null) unresolvedReasons.push("missing_or_invalid_fx");
      } else {
        const coverage = data.fx.validateCoverage(event.currency, profile.homeCurrency, event.settlementDate, event.source);
        issues.push(...coverage);
        if (coverage.length > 0) unresolvedReasons.push("missing_or_invalid_fx");
      }
    }
    let cashFact: CashFact | null = null;
    if (["historical_settled", "confirmed_future", "same_day_dated"].includes(category) && conversion !== null && event.settlementDate !== null && event.direction !== "non_cash") {
      cashFact = Object.freeze({
        id: JSON.stringify(["cash", event.id]), eventId: event.id, date: event.settlementDate,
        direction: event.direction, movement: event.direction === "debit" ? conversion.converted.negate() : conversion.converted,
        conversion, source: event.source,
      });
    }
    const evidence = data.evidence.filter((item) => item.userId === event.userId &&
      (item.requestId === null || item.requestId === request.id) && item.relatedEventId === event.id);
    records.push(Object.freeze({
      event, category, conversion, cashFact, realizedCash: cashFact !== null && event.status === "settled" ? "dated_fact" : "none",
      unresolvedReasons: Object.freeze(unresolvedReasons),
      messageIds: Object.freeze(evidence.filter((item) => item.kind === "message").map((item) => item.id).sort(compareIds)),
      imageIds: Object.freeze(evidence.filter((item) => item.kind === "image").map((item) => item.id).sort(compareIds)),
    }));
  }
  const sortedIssues = sortIssues(issues);
  if (sortedIssues.some((issue) => issue.severity === "error")) return { state: null, issues: sortedIssues };
  const selected = (category: StateCategory): readonly StateRecord[] => Object.freeze(records.filter((row) => row.category === category));
  const cash = (category: StateCategory): readonly CashFact[] =>
    Object.freeze(selected(category).flatMap((record) => record.cashFact === null ? [] : [record.cashFact]));
  const state: FinancialState = Object.freeze({
    request, profile, startingBalance: profile.startingBalance, pendingBalancePolicy,
    sameDayOrdering: "unresolved", sameDaySnapshotPolicy: "unresolved",
    records: Object.freeze(records), historicalCashFacts: cash("historical_settled"),
    confirmedFutureCommitments: cash("confirmed_future"), sameDayCashFacts: cash("same_day_dated"),
    pendingDebitExposures: selected("pending_debit"), pendingCreditClaims: selected("pending_credit"),
    failedAttempts: selected("failed"), cancelledAttempts: selected("cancelled"), nonCashRecords: selected("non_cash"),
    unresolvedRecords: Object.freeze(records.filter((record) => record.unresolvedReasons.length > 0)),
    ambiguousObligations: Object.freeze(records.filter((record) => record.category === "ambiguous_obligation" ||
      ambiguousIds.has(record.event.id) || record.unresolvedReasons.includes("failed_debt_without_confirmed_retry"))),
    lifecycleGroups: Object.freeze(groups), issues: sortedIssues,
  });
  return Object.freeze({ state, issues: sortedIssues });
}
