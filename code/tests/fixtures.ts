import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { headers } from "../src/schemas.js";
import { productionFiles } from "../src/config.js";
import type { TableName } from "../src/domain.js";

export type FixtureRows = Record<TableName, Record<string, string>[]>;

export function minimalRows(): FixtureRows {
  return {
    requests: [{
      request_id: "purchase-alpha", user_id: "person-alpha", request_date: "2025-08-01",
      request_type: "purchase", requested_amount: "100.00", desired_completion_date: "2025-08-31",
      allows_partial_payment: "true", request_text: "A desk, with drawers",
    }],
    financial_profiles: [{
      user_id: "person-alpha", home_currency: "INR", current_available_balance: "1000.00",
      minimum_balance_to_keep: "100.00", financial_priorities: "emergency_savings",
      expense_categories_to_protect: "rent", expense_categories_user_is_willing_to_reduce: "",
      expense_categories_user_is_willing_to_stop: "", payment_methods_user_will_consider: "full_payment",
      max_installment_months: "",
    }],
    financial_events: [{
      event_id: "movement-alpha", user_id: "person-alpha", event_type: "expense", description: "Rent",
      category: "rent", direction: "debit", amount: "50.00", currency: "INR", event_date: "2025-07-01",
      settlement_date: "2025-07-01", status: "settled", linked_event_id: "", flexibility: "fixed",
      minimum_allowed_amount: "",
    }],
    request_payment_options: [{
      payment_option_id: "offer-alpha", request_id: "purchase-alpha", payment_method: "full_payment",
      payment_amount: "100.00", number_of_payments: "1", first_payment_date: "2025-08-01",
      payment_frequency_days: "", financing_fee: "0", total_payable_amount: "100.00",
    }],
    messages: [{
      message_id: "note-alpha", user_id: "person-alpha", request_id: "purchase-alpha",
      related_event_id: "movement-alpha", sent_at: "2025-07-31T09:30:00Z",
      source_type: "merchant", message_text: "Private fixture evidence, never print this.",
    }],
    images: [{ image_id: "picture-alpha", user_id: "person-alpha", request_id: "purchase-alpha", related_event_id: "movement-alpha" }],
    exchange_rates: [{ rate_date: "2025-07-01", from_currency: "USD", to_currency: "INR", rate: "80.5000" }],
  };
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? '"' + value.replaceAll('"', '""') + '"' : value;
}
export function csv(columns: readonly string[], rows: readonly Record<string, string>[], newline = "\n", finalNewline = true): string {
  const lines = [columns.map(quote).join(","), ...rows.map((row) => columns.map((column) => quote(row[column] ?? "")).join(","))];
  return lines.join(newline) + (finalNewline ? newline : "");
}

export async function fixture(rows = minimalRows(), imageFiles = true): Promise<{ directory: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(resolve(tmpdir(), "buy-or-wait-ingestion-"));
  for (const table of Object.keys(productionFiles) as TableName[]) {
    await writeFile(resolve(directory, productionFiles[table]), csv(headers[table], rows[table]), "utf8");
  }
  if (imageFiles) {
    await mkdir(resolve(directory, "media", "images"), { recursive: true });
    for (const image of rows.images) {
      const imageId = image.image_id!;
      if (basename(imageId) !== imageId || imageId.includes("\\") || imageId.includes("/")) continue;
      await writeFile(resolve(directory, "media", "images", imageId + ".png"), new Uint8Array([137, 80, 78, 71]));
    }
  }
  return {
    directory,
    cleanup: async () => {
      const child = relative(resolve(tmpdir()), resolve(directory));
      if (isAbsolute(child) || child.startsWith("..") || !child.startsWith("buy-or-wait-ingestion-")) throw new Error("Unsafe fixture cleanup path");
      await rm(directory, { recursive: true, force: true });
    },
  };
}
