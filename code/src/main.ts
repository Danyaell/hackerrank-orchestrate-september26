import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatasetArgument, productionFiles } from "./config.js";
import { loadProduction } from "./data/load.js";
import { buildIndexes } from "./data/indexes.js";
import type { InspectionResult, Issue, TableName } from "./domain.js";

export function printReport(result: InspectionResult, mode: string, extraFiles: readonly string[] = []): void {
  console.log("Buy or Wait? — " + mode + " (raw structure only)");
  console.log("Runtime: " + process.version);
  console.log("Files loaded: " + [...result.filesLoaded, ...extraFiles].join(", "));
  console.log("Active requests: " + result.indexes.requestsById.size);
  console.log("Table | loaded | valid | active | ignored | invalid");
  for (const table of Object.keys(productionFiles) as TableName[]) {
    const count = result.counts[table];
    console.log([table, count.loaded, count.valid, count.active, count.ignored, count.invalid].join(" | "));
  }
  console.log("Index sizes: " + Object.entries(result.indexes).map(([name, index]) => name + "=" + index.size).join(", "));
  printIssues(result.issues);
}

export function printIssues(issues: readonly Issue[]): void {
  const warnings = issues.filter((issue) => issue.severity === "warning").length;
  const errors = issues.filter((issue) => issue.severity === "error").length;
  console.log("Warnings: " + warnings + "; Errors: " + errors);
  // Source text and field values are never printed.
  for (const issue of issues) {
    console.log([
      issue.severity.toUpperCase(), issue.code, issue.filename,
      "row=" + (issue.row ?? "file"), "field=" + (issue.field ?? "-"),
      "id=" + (issue.recordId ?? "-"), issue.explanation,
    ].join(" | "));
  }
  console.log(errors === 0 ? "Result: SUCCESS" : "Result: FAILURE");
}

export async function runInspection(args: readonly string[]): Promise<number> {
  if (args[0] !== "inspect") throw new Error("Usage: node main.js inspect [--dataset <directory>]");
  const datasetDirectory = parseDatasetArgument(args.slice(1));
  const loaded = await loadProduction(datasetDirectory);
  const result = await buildIndexes(loaded, datasetDirectory);
  printReport(result, "production inspection");
  return result.issues.some((issue) => issue.severity === "error") ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runInspection(process.argv.slice(2));
  } catch {
    console.error("CLI_ERROR: invalid arguments or unexpected inspection failure. Use inspect --dataset <directory>; ambiguous relative paths require an absolute path.");
    process.exitCode = 1;
  }
}
