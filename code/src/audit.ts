// Separate executable: no production module imports this file.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { parseDatasetArgument, sortIssues } from "./config.js";
import { dateOnly, decimal, id, requestSchema, headers } from "./schemas.js";
import { loadProduction, parseCsv } from "./data/load.js";
import type { ParsedCsv } from "./data/load.js";
import { buildIndexes } from "./data/indexes.js";
import { printReport } from "./main.js";
import type { Issue, RecordWithSource, Request } from "./domain.js";

const outputFields = [
  "amount_safe_to_pay", "affordability_status", "recommended_payment_method",
  "payment_plan", "earliest_date_for_full_payment", "spending_changes_needed", "decision_explanation",
] as const;
const sampleSchema = requestSchema.extend({
  amount_safe_to_pay: decimal,
  affordability_status: z.enum(["affordable_now", "affordable_with_plan", "affordable_later", "not_affordable"]),
  recommended_payment_method: z.enum(["full_payment", "partial_payment", "installments", "wait", "not_recommended"]),
  payment_plan: z.string().regex(/^(?:none|\d{4}-\d{2}-\d{2}:\d+(?:\.\d+)?(?:\|\d{4}-\d{2}-\d{2}:\d+(?:\.\d+)?)*)$/)
    .refine((value) => value === "none" || value.split("|").every((payment) => dateOnly.safeParse(payment.split(":")[0]).success), "Invalid payment date"),
  earliest_date_for_full_payment: z.union([z.literal("").transform(() => null), dateOnly]),
  spending_changes_needed: z.string().refine((value) => value === "none" ||
    (value.split("|").length <= 3 && value.split("|").every((action) => /^(?:stop:[^:|]+|reduce_to:[^:|]+:\d+(?:\.\d+)?)$/.test(action))), "Invalid spending-action syntax"),
  decision_explanation: z.string().min(1),
});
const templateSchema = z.strictObject({
  request_id: id,
  amount_safe_to_pay: z.literal(""),
  affordability_status: z.literal(""),
  recommended_payment_method: z.literal(""),
  payment_plan: z.literal(""),
  earliest_date_for_full_payment: z.literal(""),
  spending_changes_needed: z.literal(""),
  decision_explanation: z.literal(""),
});

async function readAuditCsv<T>(directory: string, filename: string, columns: readonly string[], schema: z.ZodType<T>): Promise<ParsedCsv<T>> {
  try {
    return parseCsv(await readFile(resolve(directory, filename)), filename, columns, schema, "request_id");
  } catch {
    return { records: [], loaded: 0, issues: [{
      code: "FILE_READ_ERROR", severity: "error", filename, row: null, field: null,
      recordId: null, explanation: "Cannot read audit-only CSV file",
    }] };
  }
}

export async function runAudit(args: readonly string[]): Promise<number> {
  if (args[0] !== "audit") throw new Error("Usage: node audit.js audit [--dataset <directory>]");
  const directory = parseDatasetArgument(args.slice(1));
  const loaded = await loadProduction(directory);
  const samples = await readAuditCsv(directory, "sample_requests.csv", [...headers.requests, ...outputFields], sampleSchema);
  const template = await readAuditCsv(directory, "output.csv", ["request_id", ...outputFields], templateSchema);
  // Only input columns enter the structural indexes; completed fields remain local to this executable.
  const sampleInputs: readonly RecordWithSource<Request>[] = samples.records.map((row) => Object.freeze({
    source: row.source,
    data: Object.freeze(Object.fromEntries(headers.requests.map((field) => [field, row.data[field as keyof Request]])) as Request),
  }));
  const issues: Issue[] = [...loaded.issues, ...samples.issues, ...template.issues];
  const evaluationIds = new Set(loaded.tables.requests.map((row) => row.data.request_id));
  const templateIds = new Set<string>();
  for (const row of template.records) {
    if (templateIds.has(row.data.request_id)) issues.push({
      ...row.source, code: "DUPLICATE_KEY", severity: "error", field: "request_id", explanation: "Template request ID is duplicated",
    });
    templateIds.add(row.data.request_id);
    if (!evaluationIds.has(row.data.request_id)) issues.push({
      ...row.source, code: "MISSING_FOREIGN_KEY", severity: "error", field: "request_id", explanation: "Template ID does not reference an evaluation request",
    });
  }
  for (const row of loaded.tables.requests) {
    if (!templateIds.has(row.data.request_id)) issues.push({
      filename: "output.csv", row: null, recordId: row.data.request_id, code: "MISSING_TEMPLATE_ROW",
      severity: "error", field: "request_id", explanation: "Evaluation request has no template row",
    });
  }
  const requestInputs = Object.freeze([...loaded.tables.requests, ...sampleInputs]);
  const auditInput = {
    ...loaded,
    tables: { ...loaded.tables, requests: requestInputs },
    loadedCounts: { ...loaded.loadedCounts, requests: loaded.loadedCounts.requests + samples.loaded },
    issues: sortIssues(issues),
  };
  const result = await buildIndexes(auditInput, directory, requestInputs, "audit");
  console.log("Audit-only tables: sample_requests loaded=" + samples.loaded + " valid=" + samples.records.length +
    "; output template loaded=" + template.loaded + " valid=" + template.records.length);
  console.log("Requests index in audit combines evaluation and sample input columns.");
  const auditFilesLoaded = [
    ...(!samples.issues.some((issue) => issue.code === "FILE_READ_ERROR") ? ["sample_requests.csv"] : []),
    ...(!template.issues.some((issue) => issue.code === "FILE_READ_ERROR") ? ["output.csv"] : []),
  ];
  printReport(result, "full structural audit", auditFilesLoaded);
  return result.issues.some((issue) => issue.severity === "error") ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runAudit(process.argv.slice(2));
  } catch {
    console.error("CLI_ERROR: invalid arguments or unexpected audit failure. Use audit --dataset <directory>; ambiguous relative paths require an absolute path.");
    process.exitCode = 1;
  }
}
