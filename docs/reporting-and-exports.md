# Catalog mapping, rollups, pagination, exports and alerts

Implemented 2026-11-15 for MOE-011, MOE-012 and MOE-015. All routes require `read` permission and accept the standard `labelId` / `labelIds` / `familyId` / `source` / `from` / `to` scope filters; label and source allowlists apply exactly as for `/v1/summary`.

## MOE-011 canonical ISRC mapping

- ISRCs are canonicalized to 12 uppercase characters without hyphens or spaces (`us-aaa-26-00001` → `USAAA2600001`) for catalog tracks and facts.
- An ISRC can belong to at most one track per label (`409` otherwise; guarded by a per-label/ISRC advisory lock).
- A fact carrying `isrc` resolves to that label's track, release and artist when exactly one track matches. Conflicting explicit `trackId`/`releaseId`/`artistId` values are rejected with `422`. An ISRC not yet in the catalog is stored on the fact unmapped rather than guessed.
- `GET /v1/catalog/isrc/{isrc}` returns the accessible canonical tracks and mapped/unmapped fact counts per label. `GET /v1/catalog/unmapped-isrcs` lists ISRCs seen in facts without a catalog track, most frequent first, so operators can complete the catalog.
- ISRC syntax and mapping are not evidence of rights ownership.

## MOE-012 pagination and rollups

- `GET /v1/facts?limit=&cursor=` pages facts in `(occurred_at,id)` order (limit 1–1000, default 100). `GET /v1/catalog?limit=&cursor=&kind=` pages catalog items by `(label,id)`. Cursors are opaque and validated; a malformed cursor is `400`. Without `limit`, `cursor` or `kind`, `/v1/catalog` keeps its original unpaged response.
- `GET /v1/rollups/daily` aggregates in SQL by UTC date, label, source, type and currency (`facts`, `quantity`, `amountMinor`), paged by the group key (limit 1–5000, default 1000). Shared logical activities are counted once at their first `(occurred_at,id)` occurrence, matching `/v1/summary`. Totals are exact; values beyond JavaScript's safe range are decimal strings.
- These are on-demand SQL aggregates backed by indexes, not materialized tables. A materialized rollup table with incremental refresh remains open if query latency requires it.

## MOE-015 exports and anomaly alerts

- `GET /v1/exports/facts.csv` streams every scoped fact; `GET /v1/exports/daily.csv` streams the daily rollups. Output is RFC 4180 CSV with `Content-Disposition: attachment`. Cells beginning with `=`, `+`, `-`, `@`, tab or carriage return (other than plain numbers) are prefixed with `'` to neutralize spreadsheet formulas.
- `GET /v1/alerts` evaluates, on request: `source_stale` (no ingest for `staleHours`, default 48; critical beyond 3×), `jobs_dead_letter`, `jobs_backlog_stale` (ready jobs waiting longer than `backlogMinutes`, default 60), and `volume_drop` / `volume_spike` (last complete UTC day at or below 20% or at least 5× the mean of the preceding 14 days, only when that mean is at least `minBaseline`, default 10). Responses include thresholds, evaluation time and window.
- Alerts are derived state. Notification delivery, acknowledgement, budgets and operational acceptance remain deployment work and are not claimed here.

Evidence: `tests/reporting.test.js` (PGlite locally; CI also runs against PostgreSQL). Security review is AI-assisted source review plus these tests; independent human review remains pending.
