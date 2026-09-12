import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { productionFiles, sortIssues } from "../config.js";
import type {
  DataIndexes, ExchangeRate, InspectionResult, Issue, LoadedData, RecordWithSource,
  Request, TableCount, TableName, Tables,
} from "../domain.js";

export function directedRateKey(rate: Readonly<ExchangeRate>): string {
  return JSON.stringify([rate.rate_date, rate.from_currency, rate.to_currency]);
}

function group<T>(rows: readonly RecordWithSource<T>[], key: (data: Readonly<T>) => string | null):
  ReadonlyMap<string, readonly RecordWithSource<T>[]> {
  const result = new Map<string, RecordWithSource<T>[]>();
  for (const row of rows) {
    const value = key(row.data);
    if (value === null) continue;
    const list = result.get(value) ?? [];
    list.push(row);
    result.set(value, list);
  }
  for (const [value, rowsForKey] of result) result.set(value, Object.freeze(rowsForKey) as RecordWithSource<T>[]);
  return result;
}

/** Structural relationships only. No event states or monetary values are interpreted. */
export async function buildIndexes(
  loaded: LoadedData, datasetDirectory: string,
  activeRequests: readonly RecordWithSource<Request>[] = loaded.tables.requests,
  scope: "production" | "audit" = "production",
): Promise<InspectionResult> {
  const issues: Issue[] = [...loaded.issues];
  function add<T>(row: RecordWithSource<T>, code: string, field: string, explanation: string, severity: "error" | "warning" = "error"): void {
    issues.push({ ...row.source, code, severity, field, explanation });
  }
  function unique<T>(rows: readonly RecordWithSource<T>[], key: (data: Readonly<T>) => string, field: string): ReadonlyMap<string, RecordWithSource<T>> {
    const result = new Map<string, RecordWithSource<T>>();
    for (const row of rows) {
      const value = key(row.data);
      if (result.has(value)) add(row, "DUPLICATE_KEY", field, "Primary or composite key is duplicated; existing index entry was not overwritten");
      else result.set(value, row);
    }
    return result;
  }
  const requestsById = unique(activeRequests, (row) => row.request_id, "request_id");
  const users = new Set(activeRequests.map((row) => row.data.user_id));
  const allProfiles = unique(loaded.tables.financial_profiles, (row) => row.user_id, "user_id");
  const allEvents = unique(loaded.tables.financial_events, (row) => row.event_id, "event_id");
  unique(loaded.tables.request_payment_options, (row) => row.payment_option_id, "payment_option_id");
  unique(loaded.tables.messages, (row) => row.message_id, "message_id");
  unique(loaded.tables.images, (row) => row.image_id, "image_id");
  const ratesByDirectedPair = unique(loaded.tables.exchange_rates, directedRateKey, "rate_date,from_currency,to_currency");

  // Request-linked records with an active request are retained even if user ownership is wrong,
  // so an ownership error cannot be hidden by filtering. Unrelated sample requests are ignored.
  const evidenceIsActive = (row: { readonly user_id: string; readonly request_id: string | null }) =>
    scope === "audit" || users.has(row.user_id) || (row.request_id !== null && requestsById.has(row.request_id));
  const tables: Tables = Object.freeze({
    requests: Object.freeze([...activeRequests]),
    financial_profiles: Object.freeze(loaded.tables.financial_profiles.filter((row) => scope === "audit" || users.has(row.data.user_id))),
    financial_events: Object.freeze(loaded.tables.financial_events.filter((row) => scope === "audit" || users.has(row.data.user_id))),
    request_payment_options: Object.freeze(loaded.tables.request_payment_options.filter((row) => scope === "audit" || requestsById.has(row.data.request_id))),
    messages: Object.freeze(loaded.tables.messages.filter((row) => evidenceIsActive(row.data))),
    images: Object.freeze(loaded.tables.images.filter((row) => evidenceIsActive(row.data))),
    exchange_rates: loaded.tables.exchange_rates,
  });
  const profilesByUser = new Map([...allProfiles].filter(([user]) => users.has(user)));
  const eventsById = new Map([...allEvents].filter(([, row]) => users.has(row.data.user_id)));
  function checkUser<T extends { readonly user_id: string }>(row: RecordWithSource<T>): void {
    if (!allProfiles.has(row.data.user_id)) add(row, "MISSING_FOREIGN_KEY", "user_id", "Referenced user profile does not exist");
  }
  function checkEvent<T extends { readonly user_id: string }>(row: RecordWithSource<T>, reference: string | null, field: string): void {
    if (reference === null) return;
    const event = allEvents.get(reference);
    if (!event) add(row, "MISSING_FOREIGN_KEY", field, "Referenced event does not exist");
    else if (event.data.user_id !== row.data.user_id) add(row, "OWNERSHIP_MISMATCH", field, "Referenced event belongs to another user");
  }
  function checkRequest<T extends { readonly user_id: string; readonly request_id: string | null }>(row: RecordWithSource<T>): void {
    if (row.data.request_id === null) return;
    const request = requestsById.get(row.data.request_id);
    if (!request) add(row, "MISSING_FOREIGN_KEY", "request_id", "Referenced active request does not exist");
    else if (request.data.user_id !== row.data.user_id) add(row, "OWNERSHIP_MISMATCH", "request_id", "Referenced request belongs to another user");
  }
  for (const row of tables.requests) checkUser(row);
  for (const row of tables.financial_events) {
    checkUser(row);
    checkEvent(row, row.data.linked_event_id, "linked_event_id");
    if (row.data.linked_event_id === row.data.event_id) add(row, "SELF_REFERENCE", "linked_event_id", "An event cannot link to itself");
    if (row.data.amount === null) add(row, "UNRESOLVED_AMOUNT", "amount", "Amount is absent and remains null; no monetary interpretation was made", "warning");
  }
  const evidenceRows: readonly RecordWithSource<{ user_id: string; request_id: string | null; related_event_id: string | null }>[] =
    [...tables.messages, ...tables.images];
  for (const row of evidenceRows) {
    checkUser(row);
    checkRequest(row);
    checkEvent(row, row.data.related_event_id, "related_event_id");
  }
  for (const row of tables.request_payment_options) {
    if (!requestsById.has(row.data.request_id)) add(row, "MISSING_FOREIGN_KEY", "request_id", "Referenced active request does not exist");
  }
  const optionsByRequest = group(tables.request_payment_options, (row) => row.request_id);
  for (const row of tables.requests) {
    if (!optionsByRequest.has(row.data.request_id)) add(row, "MISSING_PAYMENT_OPTIONS", "request_id", "Active request has no supplied payment option");
  }
  const imageRoot = resolve(datasetDirectory, "media", "images");
  for (const row of tables.images) {
    const filename = resolve(imageRoot, row.data.image_id + ".png");
    if (dirname(filename) !== imageRoot) {
      add(row, "UNSAFE_IMAGE_PATH", "image_id", "Image identifier cannot resolve outside the image directory");
      continue;
    }
    try {
      if (!(await stat(filename)).isFile()) throw new Error("Not a file");
    } catch {
      add(row, "MISSING_IMAGE_FILE", "image_id", "Referenced image PNG is absent or inaccessible");
    }
  }
  const indexes: DataIndexes = Object.freeze({
    requestsById, profilesByUser, eventsById,
    eventsByUser: group(tables.financial_events, (row) => row.user_id),
    optionsByRequest,
    messagesByUser: group(tables.messages, (row) => row.user_id),
    messagesByRequest: group(tables.messages, (row) => row.request_id),
    messagesByEvent: group(tables.messages, (row) => row.related_event_id),
    imagesByUser: group(tables.images, (row) => row.user_id),
    imagesByRequest: group(tables.images, (row) => row.request_id),
    imagesByEvent: group(tables.images, (row) => row.related_event_id),
    ratesByDirectedPair,
  });
  const counts = {} as Record<TableName, TableCount>;
  for (const table of Object.keys(productionFiles) as TableName[]) {
    const valid = loaded.tables[table].length;
    const active = tables[table].length;
    const loadedCount = loaded.loadedCounts[table];
    counts[table] = Object.freeze({
      loaded: loadedCount, valid, active, ignored: valid - active, invalid: loadedCount - valid,
    });
  }
  return Object.freeze({ filesLoaded: loaded.filesLoaded, indexes, tables, counts: Object.freeze(counts), issues: sortIssues(issues) });
}
