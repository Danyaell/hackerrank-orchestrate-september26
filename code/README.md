# Buy or Wait? — Slices 1–4

This package validates raw CSV structure and relationships, normalizes exact financial values, reconstructs supplied financial state, evaluates historical recurrence candidates, and constructs baseline financial forecasts and scenario traces. **No recommendation engine or final prediction generator exists yet.**

## Requirements and installation

Use Node.js **24 LTS** and npm. The engine constraint targets the major line, not one patch version. Development and real-data verification used Node **v24.18.0**, npm **11.16.0**, and TypeScript **6.0.3**.

From the repository root, on Windows or Linux:

~~~text
npm --prefix code ci
npm --prefix code run check
npm --prefix code run build
npm --prefix code test
npm --prefix code run test:ingestion
npm --prefix code run test:recurrence
npm --prefix code run test:forecast
~~~

The lockfile pins all dependency versions. Runtime dependencies are zod (schemas), csv-parse (CSV parsing), and decimal.js (exact money operations). Development dependencies are TypeScript 6 and Node 24 type definitions. Tests use node:test and node:assert/strict. Build before running tests or inspection commands. No AI credentials or network access are needed after dependencies are installed; a populated npm cache also permits npm --prefix code ci --offline --no-audit --no-fund.

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
- In ingestion, monetary values remain original validated unsigned plain decimal strings. Empty optional amounts, dates, integer fields and references become null; missing amounts never become zero. Empty category lists remain empty strings. Boolean fields become booleans; pipe-separated lists and non-monetary integers otherwise remain strings. Normalization retains the raw records and decimal text alongside Money objects.
- Schemas enforce the current contract's currencies, categories and enums, Gregorian dates and ISO timestamps. IDs remain opaque non-empty strings. Image IDs must resolve within media/images/; only file existence is checked, not image contents.
- Validated records and grouped arrays are frozen; indexes expose readonly map types. Duplicate keys generate errors and never overwrite an existing index entry. Do not consume indexes as trusted complete data when errors are present.
- Issues have stable codes, severity, filename, row, field, record ID and explanation. Reports sort issues deterministically and never print full source messages or raw field values. Errors cause exit status 1; warnings alone do not.
- UNRESOLVED_AMOUNT warns that a supplied event amount is absent. It remains unresolved awaiting evidence, not an ingestion failure or a zero-value movement.

## State inspection

Use an actual ID from the active requests CSV:

~~~text
npm --prefix code run inspect:state -- --dataset ../dataset --request <request_id>
npm --prefix code run inspect:states -- --dataset ../dataset
~~~

Both commands use the same seven-file production reader. They report state counts, currency metadata, lifecycle relationships and diagnostics without reading solved outputs or extracting message/image contents. The all-request command sums per-request state counts and deduplicates identical diagnostics. Blocking reconstruction errors return no usable state and exit nonzero.

- Money has a private immutable decimal-string boundary. Each addition/subtraction uses precision sufficient for the maximum integer and fractional widths plus a carry margin; multiplication uses the sum of operand digit widths plus a margin. Decimal instances never leave core operations. This preserves finite decimal arithmetic without default-precision truncation. Currency-mismatched operations fail.
- Signed money supports debit movements; raw profile/event amount fields remain non-negative. Exact serialization emits plain canonical decimal text. Fixed-scale serialization requires an explicit rounding mode. Round-down means mathematical floor, including negative values; it is not used for capacity calculations. Zero cannot serialize as negative zero.
- DateOnly uses integer Gregorian day ordinals for years 0001–9999, with no timezone, system clock or locale parsing. Whole-day arithmetic and anchored calendar-month arithmetic are provided. Monthly callers retain the original day or explicit month-end anchor to avoid cumulative clipping drift.
- FX uses source amount times the supplied directed settlement-date rate into the user's home currency. Same-currency amounts need no rate. Original and converted Money, source provenance, rate text/date and rate-row provenance are retained. Missing, reverse-only or non-unique rates block conversion; no reciprocal or date fallback exists. Missing foreign amounts can validate rate coverage without manufacturing an amount.
- The profile balance is an unchanged snapshot. Prior settled cash is retained as history and never replayed. Supplied future settled/scheduled cash becomes dated facts/commitments. Pending debits are separate exposures, and pending credits/refunds remain unavailable claims. Failed/cancelled attempts have no cash fact. Non-cash/unrealized valuations remain non-cash; investment purchases and sales follow actual cash direction.
- Pending-balance policy defaults explicitly to unknown; includes_holds and excludes_holds are represented without changing the snapshot. Same-day ordering and whether same-day settlements are in the snapshot remain unresolved. ID sorting is presentation order only.
- Lifecycle groups reference records rather than copying them. Cancelled replacement, settled/pending refund, failed debt retry and investment valuation/sale patterns are recognized. Generic links remain ambiguous and never silently deduplicate debits. Cycles, self-links, cross-user links, duplicate identities/conflicting parents block reconstruction. A failed debt without a confirmed retry or a past scheduled obligation remains uncertain, with no invented future date.
- Unresolved amounts never produce cash facts. Genuine supplied zero remains a resolved zero fact. Invalid amount text is rejected during ingestion.

## Recurrence inspection and historical calibration

~~~text
npm --prefix code run inspect:recurrence -- --dataset ../dataset --request <request_id>
npm --prefix code run backtest:recurrence -- --dataset ../dataset
npm --prefix code run backtest:recurrence -- --dataset ../dataset --write-report
~~~

Recurrence uses only settled, resolved cash history strictly before the request date, with valid conversion provenance. Original source-currency observations determine cadence and amount behavior. Refunds, investments, pending/failed/cancelled attempts, unresolved values, ambiguous lifecycle components, unestablished income transfers, and generic bonus/commission/reimbursement/windfall purposes are excluded. A real reported zero remains an observation; absence never becomes zero. Raw message/image contents are not interpreted.

Description, category and hybrid grouping policies are compared. Description normalization preserves digits and meaningful symbols. Variable-purpose category streams separate established fixed bills, and their matching signatures exclude those bills. Supported schedules are calendar-monthly with a retained day/month-end anchor or fixed intervals derived from actual gaps. Date deviations and recent cadence/amount changes are explicit diagnostics. Low-support, irregular, stale or uncertain income is never presented as supported future income; expenses may retain conservative ambiguity. Supplied future commitments are separate references, never training observations or additional generated cash movements.

The backtester is a separate evaluation executable. The existing TypeScript project includes it through its recurrence tests' import, so the ordinary build compiles it without a second configuration. It uses the same seven-file production reader and never imports the structural audit. At each distinct availability date (later of posting and settlement), it recalculates eligibility and grouping from the prefix and expands that prefix. Predictions with unchanged support are evaluated once. A withheld target's eligibility is frozen when it becomes available; later lifecycle links cannot censor earlier training or retrospectively remove a scored target. Same-date observations are exposed together; this is a training boundary, not a financial movement-ordering policy.

The command prints JSON with every predefined policy, exact fraction metrics, per-currency and direction monetary errors, exclusion counts, input/source hashes, and the selected global policy. Means and even-sample medians use reduced rational amounts when no finite decimal exists; they are never rounded into Money. Quantile ranks use integer arithmetic. Weighted relative error is absolute error divided by actual nonzero amount totals **within each currency and direction**, then averaged across currencies. It is not the mean of individual percentage errors. Monetary magnitudes in different currencies are never added. The prespecified recurrence-selection-v2 objective first minimizes unsafe income loss. It then minimizes four times unsafe expense loss, plus explicit over-reservation cost, unsafe date rate, coverage loss and one tenth unsupported rate. Unsafe loss includes amount error divided by actual amount and the unsafe prediction rate, so genuine zero is not ignored. Exact ties prefer lower documented complexity, higher coverage/date accuracy, then lexicographic version. Support below three expense/five income observations and income grace periods are inadmissible. Apparent end-continuations are censored at the request boundary and are not proven cancellations.

The optional --write-report flag regenerates evaluation/recurrence_report.md from the current implementation and inputs. It includes raw-byte SHA-256 manifests, Git reference when available, runtime, the command, all candidate metrics, selection rationale and limitations. The renderer has no clock or hand-entered metrics; identical source/inputs/runtime/Git reference yield identical bytes. Normal backtesting writes no report. Rebuild after source changes before generating the report. Coverage counts observations eligible when historically available; request-snapshot eligible/exclusion counts are reported separately, so later disputes cannot change that chronological denominator.

The provisional policy is explicit in src/config.ts and has a deterministic SHA-256 hash. See evaluation/recurrence_report.md for measured comparisons, selection rationale, sensitivity, and uncertainties. Inspection emits only series metadata, counts and diagnostic next dates, not a cash-flow forecast. The policy estimatedAmount is the strict safety estimate; referenceAmount is a recent-window median explicitly tagged diagnostic_only and cannot establish feasibility. Activity is explicitly provisional, with cadence_only or uncertain confidence. Inactive and ambiguous income is ineligible; inactive/ambiguous expense remains must_review and cannot silently disappear. Diagnostic dates on ambiguous expense candidates may be overdue; downstream code must not treat them as confirmed commitments.

## Baseline forecast and capacity diagnostics

~~~text
npm --prefix code run inspect:forecast -- --dataset ../dataset --request <request_id>
npm --prefix code run inspect:capacity -- --dataset ../dataset --request <request_id>
npm --prefix code run inspect:capacities -- --dataset ../dataset
~~~

These commands use the seven-file production boundary. They read no solved outputs, write no predictions, and accept arbitrary active request IDs. Forecast inspection reports movement identities, source references, suppression rationale and dated FX provenance; capacity inspection reports scenario minima, breach counts and limiting checkpoints. Full daily opening/closing balances, reservations, movements and checkpoints are available through the typed simulator API without exposing message or image content.

The explicit `forecast-v1-inclusive-90` policy covers the request date through request date plus 90 calendar days, **inclusive (91 dates)**. Its configuration and deterministic hash are reported separately from the recurrence policy hash. No clock is consulted. Historical cash is never replayed against the profile snapshot. Supplied future cash identities are retained once. Supported active recurrence uses only the selected strict safety estimate; its reference median never enters feasibility calculations. Unsupported, stale or ambiguous income is excluded. Uncertain expenses retain provenance and structured unresolved obligations; missing debit amounts block capacity. A known undated debt may receive a conservative reserve but is never described as realized failed cash.

Generated occurrences are suppressed only for a unique compatible supplied obligation at the same schedule date, with user, direction, event type, category, source currency, signature and description identity (or an explicit supporting-event relationship for a pooled stream). Category/date/amount similarity alone cannot suppress a movement. Compatible pending exposures also participate in this check. Supplied amounts take precedence over inference, and all suppression decisions remain inspectable. Multiple matches remain ambiguous rather than being arbitrarily merged.

Both pending snapshot hypotheses and both same-day cash orders are simulated. When the snapshot includes a hold, its ledger receives an accounting gross-up matched by the reservation, creating **no spendable income**. When it excludes holds, reservations reduce spendable funds at the request boundary. Settlement releases the hold and debits it atomically, never exposing a temporary credit or charging it twice. A pending row's supplied date is tentative; that transition leaves spendable funds unchanged. Past/undated pending exposure remains held. A uniquely linked identical settlement can replace the tentative transition, while any unresolved lifecycle classification remains explicitly unresolved. Pending credits/refunds and unsettled speculative credits never add available funds. Same-day settled debits may already be in the snapshot; their conservative trace remains unresolved, and same-day settled credits are excluded.

Scenario safety is checked at opening, after each ordered movement, and at closing. Diagnostic purchase debits occur after opening reserves **before any same-day cash**, in either intraday hypothesis. Stable IDs only break ties within a financial phase. Capacity takes the least headroom across valid scenarios and verifies that exact boundary through injected simulation. It is uncapped by requested price and receives no preference/deadline/spending-change filtering. It is never rounded upward. A baseline breach yields `unsafe`; missing values or FX yield `blocked`; unresolved liability identity/continuity yields `conservative_unresolved`. All three return no claimed safe capacity or earliest payment date.

For valid baselines, earliest full-payment feasibility searches the inclusive horizon independently of preferences and deadline. A suffix-headroom check proves impossible dates unsafe; each remaining candidate receives full injected simulation across every scenario and every checkpoint. It can therefore return the following day after a credit, rather than relying on that credit arriving before the payment. Null on a blocked/unresolved baseline means unknown, not proven impossibility.

The all-request command continues through every request, aggregates blockers and returns status 1 if any blocking error exists. Warning-only unresolved diagnostics return status 0 without claiming a safe result. Baseline-breach counts include breached traces even when blocked/unresolved takes status precedence. Pending sensitivity means the snapshot hypotheses change spendable traces; same-day sensitivity means they change at least one daily checkpoint minimum, even if the global limiting checkpoint is unchanged. Missing projected FX counts occurrences, not requests. Only strictly dated directed supplied FX is used; no live, latest-date or reciprocal fallback is available.

## Current limitations

This package does not generate payment plans, expand installments, select payment methods, change spending, classify affordability, extract evidence, score solved answers, or write final predictions. Safety is conditional on the supplied facts and provisional recurrence policy, not a guarantee against unknown expenses. Unbounded liabilities remain unresolved. Image validation does not decode PNGs. Readonly maps are a TypeScript API boundary rather than runtime immutable map implementations. Linux execution has not yet been verified directly. Recurrence cannot establish cancellations, source continuity, or same-purpose amendments from unparsed evidence; source records do not provide historical revision timestamps.

Non-blocking technical debt: Money's large accepted serialization scale/precision bounds must be reduced before an untrusted caller controls scale. Canonical payment options must expose method, payment count and frequency explicitly before Slice 5. Neither behavior is changed by this slice.

The unused Python starter and evaluation files are preserved. Tests generate small isolated synthetic datasets in OS temporary directories and remove them afterward; the participant dataset is never modified. The isolation tests use unreadable sample/template locations and inspect the compiled production import graph.

csv-parse 7.0.2 was selected because npm reported a prototype-related advisory affecting the initially installed version 6.2.1. All CSV parsing uses columns: false, followed by exact header validation.
