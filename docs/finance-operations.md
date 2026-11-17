# Royalties, budgets, alert delivery, provider imports and demo data

Implemented 2026-11-17 (MOE-013, MOE-012 stored rollups, MOE-015 delivery/budgets, MOE-006/010 import paths). Evidence: `tests/finance.test.js`, `tests/operations-suite.test.js` (PGlite locally; CI also runs PostgreSQL). Security review is AI-assisted source review plus these tests; independent human review remains pending.

## Revenue recognition and royalty splits (MOE-013)

- Revenue lines per label and month come from `sale`, `refund` (negative) and `royalty` facts plus imported distributor rows (net). A line is **recognized** when the source reports it settled (distributor `settled`/`reversed`, or fact `metadata.settlement = "settled"`); otherwise it is **pending**. Refunds and reversals reduce the period they occur in. Currencies are never combined.
- Split rules (`POST /v1/royalties/rules`, `ingest`): `{labelId, scopeKind: label|release|track, scopeId, splits:[{payeeId, name, shareBps}], note}`; shares must total exactly 10000 bp. `@artist` means the line's catalog artist (`artist:<id>`), `@label` the label. Precedence: track → release → label → system default (50% artist / 50% label; 100% label when the line has no artist attribution). `GET /v1/royalties/rules`, `POST /v1/royalties/rules/delete`.
- `GET /v1/royalties/preview?labelId=&period=YYYY-MM` computes per-payee statements with line detail. Allocation is exact (largest remainder).
- `POST /v1/royalties/statements {labelId, period, finalize}` stores drafts (`ingest`) or finalizes (`manage`). Finalized statements are immutable; if source data later changes, the response lists `conflicts` and the difference belongs in a later period's adjustment.
- `GET /v1/royalties/statements` (`lines=1` for detail), `GET /v1/exports/royalties.csv`, `GET /v1/royalties/balances` (finalized recognized − payouts), `POST /v1/royalties/payouts` (`manage`; refuses amounts above the balance), `GET /v1/royalties/payouts`.
- Payouts are operator-recorded evidence; the engine moves no money.

## Budgets

`POST /v1/budgets {labelId,id,name,period,category,currency,amountMinor,releaseId?}`, `POST /v1/expenses {labelId,budgetId,occurredOn,currency,amountMinor,description,vendor?}` (currency must match), `GET /v1/budgets` (spent, remaining, utilization, `ok|near-limit|over`), `GET /v1/expenses`. Budgets for the current and previous month raise `budget_near_limit` (≥90%) and `budget_overrun` (critical above 120%) alerts.

## Stored rollups (MOE-012)

`music_rollup_daily` holds per-label daily rollups. The in-process worker (`WORKER_ENABLED=1`) refreshes up to five changed labels per tick (fact watermark and count). `GET /v1/rollups/daily` for a single label with day-aligned bounds is served from the stored table when it is current (`materialized: true`, `refreshedAt`); otherwise the on-demand SQL path answers (`materialized: false`). Multi-label scopes stay on demand so cross-label shared activities are still counted once. `GET /v1/rollups/status`, `POST /v1/rollups/refresh` (`manage`).

## Alert feed and delivery (MOE-015)

The worker evaluates alerts every `ALERT_EVAL_INTERVAL_MS` (default 5 min) for every label and persists them: `GET /v1/alerts/feed?status=open|acknowledged|resolved|all`, `POST /v1/alerts/feed/{id}/ack` (`ingest`), `POST /v1/alerts/evaluate` (`manage`), `GET /v1/alerts/delivery`. Newly opened or escalated alerts are delivered only when configured (OFF by default):

| Channel | Enable with |
| --- | --- |
| Webhook | `ALERT_WEBHOOK_URL` (https), optional `ALERT_WEBHOOK_SECRET` → `X-Alert-Signature: sha256=<HMAC of body>` |
| Email | `ALERT_EMAIL_TO` (comma list), `ALERT_EMAIL_FROM`, `RESEND_API_KEY` (Resend HTTP API) |

Alerts for synthetic demo labels stay in the in-app feed and are never delivered.

## Provider connectors and CSV imports (MOE-006, MOE-010, MOE-005)

`GET /v1/providers` lists every provider, its CSV columns and live-API status. `POST /v1/imports {provider, labelId, csv, fileName?, mapping?, statementId?}` (`ingest`) imports an exported report; `GET /v1/imports` shows history with row errors.

| Provider | Upload now | Live API |
| --- | --- | --- |
| Spotify for Artists (`spotify`) | Streams CSV (date, song, ISRC, streams, country) | None public — CSV only |
| Apple Music for Artists (`apple`) | Plays CSV | None public — CSV only |
| YouTube (`youtube`) | Views CSV | YouTube Analytics API v2 pull, OFF until `CONNECTOR_MASTER_KEY`, `PROVIDER_LIVE_PULLS=youtube`, `youtube` in `WORKER_SOURCES`, and a stored connector credential `{clientId, clientSecret, refreshToken}` (`POST /v1/connectors`); then enqueue `resync` jobs |
| Stems White Label (`stems`) | Orders/licences CSV (order id, date, amount, currency, type) → sales/refunds (pending settlement) | Contract not published — CSV only |
| TooLost (`toolost`) | Statement CSV → distributor rows (ISRCs must be in the catalog) | None public — CSV only |
| Manual (`manual`) | Engine fact columns | — |

Headers are matched case-insensitively against aliases; pass `mapping: {field: "Column header"}` to override. Re-uploading the same export is idempotent (content-derived ids). Invalid rows are reported with row numbers and skipped.

## Accounts administration

`GET /v1/accounts`, `POST /v1/accounts` (create), `POST /v1/accounts/{id}` (`role`, `labelIds`, `displayName`, `disabled`, `password`; changes revoke sessions), `POST /v1/accounts/verify` (password check without a session, for a trusted console), `GET /v1/auth/me`. All except `me` require `manage`. `ENGINE_CONSOLE_KEY` adds the system-wide `command-center-console` credential; it may send `X-Acting-User` so the audit trail names the console user (recorded, not trusted for access).

## Synthetic demo data

`POST /v1/admin/demo-data` (system-wide `manage`) or `npm run seed:demo` seeds label `synthetic-demo` ("Synthetic Demo Label (not real data)", `synthetic=true`): catalog, 60 days of streams/sales/refunds/events, two TooLost-format statements, split rules, budgets, finalized and draft statements. Every fact has `metadata.synthetic=true`; `/v1/scopes` marks the label and `/v1/summary` returns `synthetic`/`syntheticLabelIds`. `POST /v1/admin/demo-data/remove` (or `npm run seed:demo -- --remove`) deletes only that synthetic label.
