# Buy or Wait? — Slice 1

This package validates raw CSV structure and relationships and prints deterministic inspection reports. **No financial decision engine or prediction generator exists yet.**

## Requirements and installation

Use Node.js **24 LTS** and npm. The engine constraint targets the major line, not one patch version. Development and real-data verification used Node **v24.18.0**, npm **11.16.0**, and TypeScript **6.0.3**.

From the repository root, on Windows or Linux:

~~~text
npm --prefix code ci
npm --prefix code run check
npm --prefix code run build
npm --prefix code test
npm --prefix code run test:ingestion
~~~

The lockfile pins all dependency versions. Runtime dependencies are zod (schemas), csv-parse (CSV parsing), and decimal.js (installed but unused in this slice). Development dependencies are TypeScript 6 and Node 24 type definitions. Tests use node:test and node:assert/strict. Build before running tests or inspection commands. No AI credentials or network access are needed after dependencies are installed; a populated npm cache also permits npm --prefix code ci --offline --no-audit --no-fund.

## Production inspection

~~~text
npm --prefix code run inspect -- --dataset ../dataset
node code/dist/src/main.js inspect --dataset dataset
~~~

Production reads exactly:

- requests.csv
- financial_profiles.csv
- financial_events.csv
- request_payment_options.csv
- messages.csv
- images.csv
- exchange_rates.csv

It never opens the sample requests or blank output template. All loaded rows receive structural validation; active indexes contain evaluation requests and their users' records. Unrelated supporting rows are counted as ignored. User-level evidence is retained for active users; evidence naming an active request is retained even when ownership is wrong so validation can report the mismatch.

Payment options naming a request outside the active set are ignored in production. Without opening sample requests, production cannot distinguish a legitimate sample option from an unknown out-of-scope request ID. The full audit checks that distinction against both supplied request sets.

## Full structural audit

~~~text
npm --prefix code run audit -- --dataset ../dataset
node code/dist/src/audit.js audit --dataset dataset
~~~

src/audit.ts is a separate executable outside the production import graph. It reads the seven production tables plus sample_requests.csv and output.csv. It validates sample output syntax and template coverage, then checks all supporting references against the union of evaluation and sample **input** columns. It does not compare predictions, calculate financial results, or use completed fields to adjust production behavior. Its requests index combines both input request sets.

## Paths, validation and diagnostics

- Dataset paths do not depend on the current working directory. Absolute paths are used directly. Relative paths are checked against the code package directory and its parent repository directory. If both anchors resolve to distinct existing directories, use an absolute path. With no option, the default is the repository's dataset directory.
- Standard Windows and POSIX native paths are supported. No local machine paths are embedded.
- Required headers must appear exactly once in the supplied order; extra headers are errors. Blank physical lines are skipped. UTF-8, an optional BOM, quoted fields, embedded commas/newlines, LF/CRLF, and an optional final newline are supported.
- Provenance uses a **one-based logical data record** number, excluding the header. Multiline quoted records still count as one record. Header errors use row 0; file-level errors use null.
- Monetary values remain original validated unsigned plain decimal strings. No rounding, arithmetic or FX conversion occurs. Empty optional amounts, dates, integer fields and references become null; missing amounts never become zero. Empty category lists remain empty strings. Boolean fields become booleans; pipe-separated lists and non-monetary integers otherwise remain strings.
- Schemas enforce the current contract's currencies, categories and enums, Gregorian dates and ISO timestamps. IDs remain opaque non-empty strings. Image IDs must resolve within media/images/; only file existence is checked, not image contents.
- Validated records and grouped arrays are frozen; indexes expose readonly map types. Duplicate keys generate errors and never overwrite an existing index entry. Do not consume indexes as trusted complete data when errors are present.
- Issues have stable codes, severity, filename, row, field, record ID and explanation. Reports sort issues deterministically and never print full source messages or raw field values. Errors cause exit status 1; warnings alone do not.
- UNRESOLVED_AMOUNT warns that a supplied event amount is absent. It is a valid unresolved field requiring a later slice, not an ingestion failure.

## Current limitations

This slice does not interpret event statuses or links, classify financial safety, convert currencies, detect recurrence, forecast, generate payment plans, extract evidence, or write predictions. Image validation does not decode PNGs. Readonly maps are a TypeScript API boundary rather than runtime immutable map implementations.

The unused Python starter and evaluation files are preserved. Tests generate small isolated synthetic datasets in OS temporary directories and remove them afterward; the participant dataset is never modified. The isolation tests use unreadable sample/template locations and inspect the compiled production import graph.

csv-parse 7.0.2 was selected because npm reported a prototype-related advisory affecting the initially installed version 6.2.1. All CSV parsing uses columns: false, followed by exact header validation.
