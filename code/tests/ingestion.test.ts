import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseCsv, loadProduction } from "../src/data/load.js";
import { buildIndexes, directedRateKey } from "../src/data/indexes.js";
import { productionFiles, projectRoot, resolveDatasetDirectory, sortIssues } from "../src/config.js";
import { eventSchema, headers, isDateOnly, messageSchema, requestSchema } from "../src/schemas.js";
import { csv, fixture, minimalRows } from "./fixtures.js";

const main = fileURLToPath(new URL("../src/main.js", import.meta.url));
const audit = fileURLToPath(new URL("../src/audit.js", import.meta.url));
const bytes = (value: string) => new TextEncoder().encode(value);
const parseRequests = (value: string) => parseCsv(bytes(value), "requests.csv", headers.requests, requestSchema, "request_id");

test("valid minimal data builds typed indexes, preserves strings and provenance, freezes rows", async (context) => {
  const input = await fixture();
  context.after(input.cleanup);
  const loaded = await loadProduction(input.directory);
  const result = await buildIndexes(loaded, input.directory);
  assert.deepEqual(result.issues, []);
  assert.equal(result.indexes.requestsById.size, 1);
  assert.equal(result.indexes.eventsByUser.size, 1);
  assert.equal(result.indexes.optionsByRequest.size, 1);
  assert.equal(result.indexes.messagesByEvent.size, 1);
  assert.equal(result.indexes.imagesByEvent.size, 1);
  const request = result.tables.requests[0]!;
  assert.equal(request.data.requested_amount, "100.00");
  assert.deepEqual(request.source, { filename: "requests.csv", row: 1, recordId: "purchase-alpha" });
  assert.ok(Object.isFrozen(request.data));
  assert.equal(result.tables.financial_profiles[0]!.data.max_installment_months, null);
  const rate = result.tables.exchange_rates[0]!;
  assert.equal(result.indexes.ratesByDirectedPair.get(directedRateKey(rate.data)), rate);
});

for (const newline of ["\n", "\r\n"]) {
  for (const finalNewline of [false, true]) {
    test("CSV quotes, commas, UTF-8 and logical row provenance: " + JSON.stringify({ newline, finalNewline }), () => {
      const rows = minimalRows().requests;
      rows[0]!.request_text = 'Desk, "oak"\nRésumé';
      const originalRows = structuredClone(rows);
      const parsed = parseRequests("\uFEFF" + csv(headers.requests, rows, newline, finalNewline));
      assert.deepEqual(parsed.issues, []);
      assert.equal(parsed.records[0]!.data.request_text, rows[0]!.request_text);
      assert.equal(parsed.records[0]!.source.row, 1);
      assert.deepEqual(rows, originalRows);
    });
  }
}

test("missing, unexpected, duplicate and reordered headers are rejected", () => {
  const rows = minimalRows().requests;
  assert.equal(parseRequests(csv(headers.requests.filter((field) => field !== "user_id"), rows)).issues[0]!.code, "MISSING_HEADER");
  assert.equal(parseRequests(csv([...headers.requests, "surprise"], rows)).issues[0]!.code, "UNEXPECTED_HEADER");
  assert.equal(parseRequests(csv([...headers.requests, "user_id"], rows)).issues[0]!.code, "DUPLICATE_HEADER");
  assert.equal(parseRequests(csv([...headers.requests].reverse(), rows)).issues[0]!.code, "HEADER_ORDER");
});

for (const [field, value] of [
  ["request_type", "unknown"], ["allows_partial_payment", "TRUE"], ["request_date", "2025-02-29"],
  ["request_date", "2025-04-31"], ["requested_amount", "1e2"], ["requested_amount", "-1"],
  ["requested_amount", "NaN"], ["requested_amount", ""], ["request_id", " "],
] as const) {
  test("invalid " + field + ": " + value, () => {
    const rows = minimalRows().requests;
    rows[0]![field] = value;
    const parsed = parseRequests(csv(headers.requests, rows));
    assert.equal(parsed.records.length, 0);
    assert.ok(parsed.issues.some((issue) => issue.code === "INVALID_FIELD" && issue.field === field));
  });
}

test("Gregorian leap years and year bounds", () => {
  assert.ok(isDateOnly("2000-02-29"));
  assert.ok(!isDateOnly("1900-02-29"));
  assert.ok(!isDateOnly("0000-01-01"));
  assert.ok(!isDateOnly("2025-13-01"));
});

test("blank optional amounts and references stay null, never zero", async (context) => {
  const rows = minimalRows();
  rows.financial_events[0]!.amount = "";
  const parsed = parseCsv(bytes(csv(headers.financial_events, rows.financial_events)), "financial_events.csv", headers.financial_events, eventSchema, "event_id");
  assert.equal(parsed.records[0]!.data.amount, null);
  assert.equal(parsed.records[0]!.data.minimum_allowed_amount, null);
  assert.equal(parsed.records[0]!.data.linked_event_id, null);
  const input = await fixture(rows);
  context.after(input.cleanup);
  const result = await buildIndexes(await loadProduction(input.directory), input.directory);
  assert.equal(result.issues[0]!.code, "UNRESOLVED_AMOUNT");
  assert.equal(result.issues[0]!.severity, "warning");
});

test("accumulates malformed rows, column counts, malformed CSV and invalid UTF-8", () => {
  const rows = minimalRows().requests;
  rows.push({ ...rows[0]!, request_id: "purchase-beta", request_type: "bad", request_date: "bad" });
  const parsed = parseRequests(csv(headers.requests, rows));
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.issues.length, 2);
  assert.ok(parsed.issues.every((issue) => issue.row === 2));
  assert.equal(parseRequests(csv(headers.requests, []) + "one,two").issues[0]!.code, "COLUMN_COUNT");
  assert.equal(parseRequests(csv(headers.requests, []) + '"unterminated').issues[0]!.code, "CSV_PARSE_ERROR");
  assert.equal(parseCsv(new Uint8Array([255]), "requests.csv", headers.requests, requestSchema, "request_id").issues[0]!.code, "CSV_PARSE_ERROR");
});

test("duplicate primary IDs and directed FX composite keys are reported without overwrite", async (context) => {
  const rows = minimalRows();
  rows.requests.push({ ...rows.requests[0]!, request_text: "Different request text" });
  rows.exchange_rates.push({ ...rows.exchange_rates[0]!, rate: "90" });
  const input = await fixture(rows);
  context.after(input.cleanup);
  const result = await buildIndexes(await loadProduction(input.directory), input.directory);
  assert.equal(result.issues.filter((issue) => issue.code === "DUPLICATE_KEY").length, 2);
  assert.equal(result.indexes.requestsById.get("purchase-alpha")!.data.request_text, "A desk, with drawers");
  assert.equal(result.indexes.ratesByDirectedPair.values().next().value!.data.rate, "80.5000");
});

test("missing required profile and linked event references are errors", async (context) => {
  const rows = minimalRows();
  rows.financial_profiles = [];
  rows.financial_events[0]!.linked_event_id = "absent-movement";
  const input = await fixture(rows);
  context.after(input.cleanup);
  const result = await buildIndexes(await loadProduction(input.directory), input.directory);
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_FOREIGN_KEY" && issue.field === "user_id"));
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_FOREIGN_KEY" && issue.field === "linked_event_id"));
});

test("request ownership and related-event ownership mismatches are retained and reported", async (context) => {
  const rows = minimalRows();
  rows.financial_profiles.push({ ...rows.financial_profiles[0]!, user_id: "person-beta" });
  rows.messages[0]!.user_id = "person-beta";
  const input = await fixture(rows);
  context.after(input.cleanup);
  const result = await buildIndexes(await loadProduction(input.directory), input.directory);
  assert.equal(result.issues.filter((issue) => issue.code === "OWNERSHIP_MISMATCH").length, 2);
  assert.equal(result.counts.messages.active, 1);
});

test("related-event missing reference, self-links and active-user unknown requests are errors", async (context) => {
  const rows = minimalRows();
  rows.financial_events[0]!.linked_event_id = "movement-alpha";
  rows.messages[0]!.related_event_id = "missing-event";
  rows.messages[0]!.request_id = "unknown-request";
  const input = await fixture(rows);
  context.after(input.cleanup);
  const result = await buildIndexes(await loadProduction(input.directory), input.directory);
  assert.ok(result.issues.some((issue) => issue.code === "SELF_REFERENCE"));
  assert.ok(result.issues.some((issue) => issue.field === "related_event_id" && issue.code === "MISSING_FOREIGN_KEY"));
  assert.ok(result.issues.some((issue) => issue.field === "request_id" && issue.code === "MISSING_FOREIGN_KEY"));
});

test("missing image file and path traversal are rejected", async (context) => {
  const rows = minimalRows();
  rows.images.push({ ...rows.images[0]!, image_id: "../escape" });
  const input = await fixture(rows, false);
  context.after(input.cleanup);
  const result = await buildIndexes(await loadProduction(input.directory), input.directory);
  assert.ok(result.issues.some((issue) => issue.code === "MISSING_IMAGE_FILE"));
  assert.ok(result.issues.some((issue) => issue.code === "UNSAFE_IMAGE_PATH"));
});

test("production allowlist and sample-output isolation; sample supporting rows are out of scope", async (context) => {
  const rows = minimalRows();
  rows.financial_profiles.push({ ...rows.financial_profiles[0]!, user_id: "dormant-person" });
  rows.financial_events.push({ ...rows.financial_events[0]!, event_id: "dormant-event", user_id: "dormant-person", linked_event_id: "absent-out-of-scope" });
  rows.request_payment_options.push({ ...rows.request_payment_options[0]!, payment_option_id: "dormant-offer", request_id: "dormant-request" });
  rows.messages.push({ ...rows.messages[0]!, message_id: "dormant-note", user_id: "dormant-person", request_id: "dormant-request" });
  rows.images.push({ ...rows.images[0]!, image_id: "dormant-image", user_id: "dormant-person", request_id: "dormant-request" });
  const input = await fixture(rows, false);
  context.after(input.cleanup);
  await mkdir(resolve(input.directory, "media", "images"), { recursive: true });
  await writeFile(resolve(input.directory, "media", "images", "picture-alpha.png"), "fixture");
  // Directories cannot be read as ordinary CSV files on Windows or Linux.
  await mkdir(resolve(input.directory, "sample_requests.csv"));
  await mkdir(resolve(input.directory, "output.csv"));
  const allowedNames = ["requests.csv", "financial_profiles.csv", "financial_events.csv",
    "request_payment_options.csv", "messages.csv", "images.csv", "exchange_rates.csv"];
  const opened: string[] = [];
  const loaded = await loadProduction(input.directory, async (path) => {
    opened.push(path);
    assert.ok(allowedNames.some((filename) => resolve(input.directory, filename) === path));
    return readFile(path);
  });
  assert.deepEqual(opened, allowedNames.map((filename) => resolve(input.directory, filename)));
  const result = await buildIndexes(loaded, input.directory);
  assert.deepEqual(result.issues, []);
  for (const table of ["financial_profiles", "financial_events", "request_payment_options", "messages", "images"] as const) {
    assert.equal(result.counts[table].ignored, 1);
  }
  const cli = spawnSync(process.execPath, [main, "inspect", "--dataset", input.directory], { encoding: "utf8", cwd: dirname(input.directory) });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
});

test("production import graph cannot reach audit, evaluation or completed-output file names", async () => {
  const visited = new Set<string>();
  async function visit(filename: string): Promise<void> {
    if (visited.has(filename)) return;
    visited.add(filename);
    const source = await readFile(filename, "utf8");
    assert.ok(!source.includes("sample_requests.csv"), filename);
    assert.ok(!source.includes('"output.csv"'), filename);
    assert.ok(!source.includes("evaluation/"), filename);
    assert.ok(!/\b(?:request|user)_\d+\b/.test(source), "Concrete repository ID in " + filename);
    for (const match of source.matchAll(/from\s+"(\.[^"]+\.js)"/g)) {
      const target = resolve(dirname(filename), match[1]!);
      assert.notEqual(target, audit);
      await visit(target);
    }
  }
  await visit(main);
  assert.deepEqual([...visited].map((file) => relativeToSource(file)).sort(), [
    "config.js", "data/indexes.js", "data/load.js", "main.js", "schemas.js",
  ]);
});

function relativeToSource(filename: string): string {
  return filename.slice(dirname(main).length + 1).replaceAll("\\", "/");
}

test("relative dataset resolution is independent of cwd and rejects ambiguous anchors", async (context) => {
  const input = await fixture();
  context.after(input.cleanup);
  const codeRoot = resolve(input.directory, "code");
  await mkdir(codeRoot);
  await mkdir(resolve(input.directory, "dataset"));
  const oldCwd = process.cwd();
  try {
    process.chdir(dirname(input.directory));
    assert.equal(resolveDatasetDirectory("dataset", codeRoot), resolve(input.directory, "dataset"));
    assert.equal(resolveDatasetDirectory("../dataset", codeRoot), resolve(input.directory, "dataset"));
    assert.equal(resolveDatasetDirectory(input.directory, codeRoot), input.directory);
    await mkdir(resolve(codeRoot, "dataset"));
    assert.throws(() => resolveDatasetDirectory("dataset", codeRoot), /Ambiguous/);
  } finally {
    process.chdir(oldCwd);
  }
});

test("stable issue ordering and nonzero CLI status without printing private evidence", async (context) => {
  const rows = minimalRows();
  rows.requests[0]!.request_type = "invalid";
  const input = await fixture(rows);
  context.after(input.cleanup);
  const loaded = await loadProduction(input.directory);
  const result = await buildIndexes(loaded, input.directory);
  assert.deepEqual(sortIssues([...result.issues].reverse()), result.issues);
  const first = spawnSync(process.execPath, [main, "inspect", "--dataset", input.directory], { encoding: "utf8" });
  const second = spawnSync(process.execPath, [main, "inspect", "--dataset", input.directory], { encoding: "utf8" });
  assert.equal(first.status, 1);
  assert.equal(first.stdout, second.stdout);
  assert.ok(first.stdout.includes("Result: FAILURE"));
  assert.ok(!first.stdout.includes("Private fixture evidence"));
});

test("missing required files accumulate errors", async (context) => {
  const input = await fixture();
  context.after(input.cleanup);
  const result = await loadProduction(input.directory, async () => { throw new Error("unavailable"); });
  assert.equal(result.issues.length, Object.keys(productionFiles).length);
  assert.deepEqual(result.filesLoaded, []);
  assert.ok(result.issues.every((issue) => issue.code === "FILE_READ_ERROR"));
});

test("audit validates all request references while keeping solved fields local", async (context) => {
  const rows = minimalRows();
  rows.request_payment_options.push({ ...rows.request_payment_options[0]!, payment_option_id: "dangling-offer", request_id: "unknown-request" });
  const input = await fixture(rows);
  context.after(input.cleanup);
  await writeFile(resolve(input.directory, "sample_requests.csv"), csv([
    ...headers.requests, "amount_safe_to_pay", "affordability_status", "recommended_payment_method",
    "payment_plan", "earliest_date_for_full_payment", "spending_changes_needed", "decision_explanation",
  ], []));
  await writeFile(resolve(input.directory, "output.csv"),
    "request_id,amount_safe_to_pay,affordability_status,recommended_payment_method,payment_plan,earliest_date_for_full_payment,spending_changes_needed,decision_explanation\npurchase-alpha,,,,,,,\n");
  const cli = spawnSync(process.execPath, [audit, "audit", "--dataset", input.directory], { encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.ok(cli.stdout.includes("MISSING_FOREIGN_KEY"));
  assert.ok(cli.stdout.includes("request_payment_options.csv"));
  assert.deepEqual((await readdir(input.directory)).filter((name) => name.endsWith(".csv")).sort(), [
    ...Object.values(productionFiles), "sample_requests.csv", "output.csv",
  ].sort());
});

test("audit reports invalid request rows in loaded and invalid counts", async (context) => {
  const rows = minimalRows();
  rows.requests.push({ ...rows.requests[0]!, request_id: "invalid-request", request_type: "invalid" });
  const input = await fixture(rows);
  context.after(input.cleanup);
  await writeFile(resolve(input.directory, "sample_requests.csv"),
    csv([...headers.requests, "amount_safe_to_pay", "affordability_status", "recommended_payment_method",
      "payment_plan", "earliest_date_for_full_payment", "spending_changes_needed", "decision_explanation"], []));
  await writeFile(resolve(input.directory, "output.csv"),
    "request_id,amount_safe_to_pay,affordability_status,recommended_payment_method,payment_plan,earliest_date_for_full_payment,spending_changes_needed,decision_explanation\npurchase-alpha,,,,,,,\n");
  const cli = spawnSync(process.execPath, [audit, "audit", "--dataset", input.directory], { encoding: "utf8" });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.ok(cli.stdout.includes("requests | 2 | 1 | 1 | 0 | 1"), cli.stdout);
});

test("configured npm test command fails when compiled test files are missing", async (context) => {
  const input = await fixture();
  context.after(input.cleanup);
  const packageJson = JSON.parse(await readFile(resolve(projectRoot, "package.json"), "utf8")) as { scripts: { test: string } };
  const command = packageJson.scripts.test.split(" ").map((argument) => argument.replace(/^"|"$/g, ""));
  assert.equal(command.shift(), "node");
  const cli = spawnSync(process.execPath, command, { encoding: "utf8", cwd: input.directory });
  assert.notEqual(cli.status, 0, "A missing compiled suite must not succeed with zero tests: " + cli.stdout);
});

test("timestamps, currencies and optional references obey raw schemas", () => {
  const message = minimalRows().messages[0]!;
  for (const sent_at of ["2026-02-30T09:00:00Z", "2026-01-01T25:00:00Z", "2026-01-01T09:00:00"]) {
    assert.ok(!messageSchema.safeParse({ ...message, sent_at }).success);
  }
  assert.ok(messageSchema.safeParse({ ...message, sent_at: "2026-01-01T09:00:00+05:30" }).success);
  const absentReferences = messageSchema.parse({ ...message, request_id: "", related_event_id: "" });
  assert.equal(absentReferences.request_id, null);
  assert.equal(absentReferences.related_event_id, null);
  const event = minimalRows().financial_events[0]!;
  for (const currency of ["INR", "ZAR", "IDR", "USD", "EUR"]) {
    assert.equal(eventSchema.parse({ ...event, currency }).amount, "50.00");
  }
  assert.ok(!eventSchema.safeParse({ ...event, currency: "GBP" }).success);
  assert.ok(!eventSchema.safeParse({ ...event, status: "reversed" }).success);
  assert.equal(eventSchema.parse({ ...event, settlement_date: "" }).settlement_date, null);
  assert.ok(!requestSchema.safeParse({ ...minimalRows().requests[0], request_date: "2026-02-30" }).success);
});

test("linked events cannot cross users and directed rates keep reversed pairs distinct", async (context) => {
  const rows = minimalRows();
  rows.financial_profiles.push({ ...rows.financial_profiles[0]!, user_id: "person-beta" });
  rows.financial_events.push({ ...rows.financial_events[0]!, event_id: "movement-beta", user_id: "person-beta" });
  rows.financial_events[0]!.linked_event_id = "movement-beta";
  rows.exchange_rates.push({ ...rows.exchange_rates[0]!, from_currency: "INR", to_currency: "USD" });
  const input = await fixture(rows);
  context.after(input.cleanup);
  const result = await buildIndexes(await loadProduction(input.directory), input.directory);
  assert.ok(result.issues.some((issue) => issue.code === "OWNERSHIP_MISMATCH" && issue.field === "linked_event_id"));
  assert.equal(result.indexes.ratesByDirectedPair.size, 2);
  assert.ok(!result.issues.some((issue) => issue.code === "DUPLICATE_KEY"));
});

test("unknown commands and invalid CLI arguments exit nonzero with a clear error", async (context) => {
  const input = await fixture();
  context.after(input.cleanup);
  for (const [executable, command] of [[main, "inspect"], [audit, "audit"]] as const) {
    for (const args of [[], ["unknown"], [command, "--dataset"], [command, "--wrong", input.directory], [command, "--dataset", input.directory, "extra"]]) {
      const cli = spawnSync(process.execPath, [executable, ...args], { encoding: "utf8", cwd: input.directory });
      assert.equal(cli.status, 1);
      assert.ok(cli.stderr.includes("CLI_ERROR"));
      assert.ok(!cli.stderr.includes("Private fixture evidence"));
    }
  }
});
