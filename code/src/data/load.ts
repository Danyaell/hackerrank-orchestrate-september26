import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";
import type { z } from "zod";
import { productionFiles, sortIssues } from "../config.js";
import { headers, schemas } from "../schemas.js";
import type { Issue, LoadedData, RecordWithSource, TableName, Tables } from "../domain.js";

export interface ParsedCsv<T> {
  readonly records: readonly RecordWithSource<T>[];
  readonly loaded: number;
  readonly issues: readonly Issue[];
}

/** Pure parsing utility: it has no filesystem access or file selection behavior. */
export function parseCsv<T>(
  bytes: Uint8Array, filename: string, expectedHeaders: readonly string[], schema: z.ZodType<T>,
  primaryField: string | null,
): ParsedCsv<T> {
  const issues: Issue[] = [];
  const records: RecordWithSource<T>[] = [];
  const issue = (code: string, row: number | null, field: string | null, recordId: string | null, explanation: string) =>
    issues.push(Object.freeze({ code, severity: "error", filename, row, field, recordId, explanation }));
  let rows: string[][];
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    rows = parse(content, { bom: true, columns: false, skip_empty_lines: true, relax_column_count: true }) as string[][];
  } catch {
    issue("CSV_PARSE_ERROR", null, null, null, "Cannot parse valid UTF-8 CSV; check encoding and quoting");
    return { records, loaded: 0, issues: sortIssues(issues) };
  }
  const actualHeaders = rows[0] ?? [];
  const loaded = Math.max(0, rows.length - 1);
  for (const header of expectedHeaders) {
    if (!actualHeaders.includes(header)) issue("MISSING_HEADER", 0, header, null, "Required header is missing");
  }
  for (const header of actualHeaders) {
    if (!expectedHeaders.includes(header)) issue("UNEXPECTED_HEADER", 0, header, null, "Header is not allowed");
  }
  if (new Set(actualHeaders).size !== actualHeaders.length) {
    issue("DUPLICATE_HEADER", 0, null, null, "Headers must be unique");
  }
  if (issues.length === 0 && actualHeaders.some((header, index) => header !== expectedHeaders[index])) {
    issue("HEADER_ORDER", 0, null, null, "Headers must follow the supplied schema order");
  }
  if (issues.length > 0) return { records, loaded, issues: sortIssues(issues) };
  for (let index = 1; index < rows.length; index++) {
    const cells = rows[index]!;
    const raw = Object.fromEntries(actualHeaders.map((header, position) => [header, cells[position] ?? ""]));
    const recordId = primaryField === null ? null : (raw[primaryField] || null);
    if (cells.length !== actualHeaders.length) {
      issue("COLUMN_COUNT", index, null, recordId, "Data record has the wrong number of columns");
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      for (const error of parsed.error.issues) {
        issue("INVALID_FIELD", index, error.path.join(".") || null, recordId, error.message);
      }
      continue;
    }
    // Zod creates new objects. Freeze them without changing caller-owned input.
    records.push(Object.freeze({
      data: Object.freeze(parsed.data),
      source: Object.freeze({ filename, row: index, recordId }),
    }));
  }
  return { records: Object.freeze(records), loaded, issues: sortIssues(issues) };
}

export type FileReader = (path: string) => Promise<Uint8Array>;

/** This is the only production file reader. Selection is a closed seven-file allowlist. */
export async function loadProduction(datasetDirectory: string, reader: FileReader = readFile): Promise<LoadedData> {
  const issues: Issue[] = [];
  const tables = {} as { [K in TableName]: Tables[K] };
  const filesLoaded: string[] = [];
  const loadedCounts = {} as Record<TableName, number>;
  for (const table of Object.keys(productionFiles) as TableName[]) {
    const filename = productionFiles[table];
    let bytes: Uint8Array;
    try {
      bytes = await reader(resolve(datasetDirectory, filename));
      filesLoaded.push(filename);
    } catch {
      issues.push({ code: "FILE_READ_ERROR", severity: "error", filename, row: null, field: null, recordId: null, explanation: "Cannot read required CSV file" });
      Object.assign(tables, { [table]: Object.freeze([]) });
      loadedCounts[table] = 0;
      continue;
    }
    const primaryField = table === "exchange_rates" ? null : headers[table][0]!;
    const result = parseCsv(bytes, filename, headers[table], schemas[table] as z.ZodType<unknown>, primaryField);
    Object.assign(tables, { [table]: result.records });
    loadedCounts[table] = result.loaded;
    issues.push(...result.issues);
  }
  return Object.freeze({ filesLoaded: Object.freeze(filesLoaded), tables: Object.freeze(tables), loadedCounts: Object.freeze(loadedCounts), issues: sortIssues(issues) });
}
