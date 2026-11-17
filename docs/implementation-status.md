# Implementation status

## Merged foundation (2026-10-09)

| PR | Delivered |
| --- | --- |
| [#1](https://github.com/neophilism/Music-Operations-Engine/pull/1) | Ingestion, PostgreSQL store, summaries, test foundation |
| [#2](https://github.com/neophilism/Music-Operations-Engine/pull/2) | Label/family scopes, catalog mappings, access-scoped server keys and auditing |
| [#3](https://github.com/neophilism/Music-Operations-Engine/pull/3) | Signed TrackZero/SceneSignal receivers, deduplication, reporting and producer SDK |
| [#5](https://github.com/neophilism/Music-Operations-Engine/pull/5) | Administrator-provisioned interactive roles, label scopes and short-lived audited sessions |
| #6 | PostgreSQL-backed ingest/resync jobs, leased claims, bounded retries, dead letters and scoped source-health timestamps |\n| #7 | Provider-neutral manifests, field mappings, resumable cursors and AES-256-GCM credential envelopes |

PRs #1–6 have been merged into `main`; #7 is the MOE-04 work package. Earlier CI passed on each merged PR head. New deployments require independent verification, not just a passing PR check.

## Infrastructure

- Dedicated Neon PostgreSQL project: `orange-forest-91354266` (credentials are never stored in Git).
- Render service: [music-operations-engine](https://dashboard.render.com/web/srv-db4oo62jnfac73fvvpmg), deployed from `main` automatically.
- Public endpoint: https://music-operations-engine.onrender.com
- State: **deploy initiated; health and database connectivity not yet verified at the time of this update**.
- Live TrackZero producer: **not connected**.
- Live SceneSignal producer: **not connected**.

## Launch validation

1. Verify `GET /health` returns a healthy database response.
2. Verify unauthenticated access to protected reports is denied.
3. Verify the server-side key can retrieve `/v1/scopes` and `/v1/sources`.
4. Register production label/recording mappings using authorized management credentials.
5. Configure distinct source keys and signing secrets; test one real TrackZero and SceneSignal event from durable app outboxes.
6. Inspect freshness, duplicate/replay handling, and mixed-family totals.
7. Add Engine Room monitoring and check actual health, deployment and source freshness (never conflate GitHub merge with a successful production launch).

## Outstanding roadmap

Account recovery, identity verification, MFA and production login rate limiting; live job workers and queue alerts; live provider activation, credential rotation drills and backfill reconciliation; TooLost, music streaming and Stems adapters; source-side TrackZero/SceneSignal exporters; ticketing; collaborators/rights; materialized rollups; royalties and reconciliation; exports, alerts, acceptance and full production hardening.

**Security boundary:** Do not publish the Render service's database URL, bootstrap API key, scoped credentials, webhook secrets or private payloads. No audio/permit/listener identities belong in this reporting backend.

## Deployment record (2026-11-15)

- Render web service `srv-dbsvhuei0phs73e95id0` (`music-operations-engine`, free plan, Virginia, Node 22, auto-deploy from `main`, health check `/health`): https://music-operations-engine-s1yz.onrender.com
- Neon project `autumn-fog-57776625` (`music-operations-engine`, PostgreSQL 17, aws-us-east-1, free), pooled connection with TLS verification.
- Runtime variables (values only in Render): `DATABASE_URL`, `ENGINE_API_KEY` (bootstrap admin), `ENGINE_CREDENTIALS` (read-only `command-center` credential used by the Command Center BFF), `NODE_VERSION`, `TRUST_PROXY`, `WORKER_ENABLED`, `WORKER_SOURCES`.
- Not configured (need owner-provided secrets or decisions): `TRACKZERO_WEBHOOK_SECRET`, `SCENESIGNAL_WEBHOOK_SECRET` (shared with those producers), `CONNECTOR_MASTER_KEY` (before storing provider credentials), provider API credentials, `CORS_ORIGIN` (not needed while the BFF calls server-side).
- Free-plan instances sleep when idle; the first request after idle is slow. Deployment is not operational acceptance: no live producer telemetry, alert delivery or backup/restore drill has been verified.

## Deployment record (2026-11-17)

- PR #20 (merge `9fcbb98`) deployed to `srv-dbsvhuei0phs73e95id0`; Render deploy `dep-dbtrr8l6e07s73b1ar8g` is live. Migration 12 (additive: royalty, rollup, alert, budget, import tables and label/account columns) applied at boot on Neon `autumn-fog-57776625`. The in-process worker refreshes stored rollups and evaluates alerts (`maintenance.run` entries in the service log).
- New runtime variable: `ENGINE_CONSOLE_KEY` (generated; shared with the Command Center as `ENGINE_WRITE_API_KEY`). The Command Center startup probe reports `health=200 authorized-read=200 console-write=200`.
- Off until the owner configures them: alert webhook/email (`ALERT_WEBHOOK_URL`/`ALERT_WEBHOOK_SECRET` or `ALERT_EMAIL_TO`/`ALERT_EMAIL_FROM`/`RESEND_API_KEY`), YouTube live pulls (`CONNECTOR_MASTER_KEY`, `PROVIDER_LIVE_PULLS=youtube`, `youtube` in `WORKER_SOURCES`, stored OAuth credential), TrackZero/SceneSignal signing secrets. Spotify for Artists, Apple Music, TooLost and Stems are fed by CSV upload.
- Synthetic demo data has not been seeded in production; an administrator can load and remove it from the Command Center Admin screen (`POST /v1/admin/demo-data`).
- Not yet verified operationally: real provider/producer data, a delivered alert on a real channel, backup/restore drill, independent human security review.

## Backup/restore drill (2026-11-17)

- Backup branch `backup-2026-11-17-engine` (`br-ancient-term-bbzkulks`, read-only endpoint) created from `main` at LSN 0/1C158F8 and kept.
- Temporary restore branch `drill-restore-2026-11-17` created from the backup, compared read-only by `scripts/backup-drill.mjs` (run once at engine boot on Render because the sandbox cannot reach Neon; drill env vars removed afterwards), then deleted.
- Result: `match: true`, schema version 12 on both, 29 tables, identical row counts and content digests. Production then held only 14 rows (bootstrap label, migrations, rollup state), so this proves the procedure, not restore time at volume. Runbook: `docs/backup-restore.md`.
