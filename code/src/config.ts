import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Issue } from "./domain.js";

export const productionFiles = Object.freeze({
  requests: "requests.csv",
  financial_profiles: "financial_profiles.csv",
  financial_events: "financial_events.csv",
  request_payment_options: "request_payment_options.csv",
  messages: "messages.csv",
  images: "images.csv",
  exchange_rates: "exchange_rates.csv",
} as const);

function locateProjectRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Cannot locate the code package directory");
    directory = parent;
  }
  return directory;
}
export const projectRoot = locateProjectRoot();

/** Relative paths use fixed package/repository anchors, never process.cwd(). */
export function resolveDatasetDirectory(argument?: string, codeRoot = projectRoot): string {
  if (argument === undefined) return resolve(codeRoot, "../dataset");
  if (isAbsolute(argument)) return resolve(argument);
  const candidates = [...new Set([
    resolve(codeRoot, argument),
    resolve(codeRoot, "..", argument),
  ])];
  const existing = candidates.filter((candidate) => existsSync(candidate) && statSync(candidate).isDirectory());
  if (existing.length > 1) throw new Error("Ambiguous dataset path: use an absolute path");
  return existing[0] ?? candidates[0]!;
}

export function parseDatasetArgument(args: readonly string[]): string {
  if (args.length === 0) return resolveDatasetDirectory();
  if (args.length !== 2 || args[0] !== "--dataset" || !args[1]) {
    throw new Error("Expected --dataset <directory>");
  }
  return resolveDatasetDirectory(args[1]);
}

export function parseStateArguments(args: readonly string[], requireRequest: boolean): { datasetDirectory: string; requestId: string | null } {
  let dataset: string | undefined;
  let requestId: string | null = null;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined || value.trim() === "") throw new Error("Missing flag value");
    if (flag === "--dataset" && dataset === undefined) dataset = value;
    else if (flag === "--request" && requireRequest && requestId === null) requestId = value;
    else throw new Error("Unknown or duplicate flag");
  }
  if (requireRequest && requestId === null) throw new Error("Expected --request <id>");
  return { datasetDirectory: resolveDatasetDirectory(dataset), requestId };
}

export function sortIssues(issues: readonly Issue[]): readonly Issue[] {
  return Object.freeze([...issues].sort((a, b) => {
    const left = [a.filename, a.row ?? -1, a.field ?? "", a.code, a.recordId ?? "", a.explanation] as const;
    const right = [b.filename, b.row ?? -1, b.field ?? "", b.code, b.recordId ?? "", b.explanation] as const;
    for (let index = 0; index < left.length; index++) {
      const x = left[index]!;
      const y = right[index]!;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  }));
}
