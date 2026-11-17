# Backup and restore runbook (Neon)

The engine's database is Neon project `autumn-fog-57776625` (default branch `main`). Neon branches are copy-on-write snapshots, so a branch is the backup and a branch created from it is the restore.

## Take a backup

1. `POST https://console.neon.tech/api/v2/projects/autumn-fog-57776625/branches` with `{"branch":{"parent_id":"<main branch id>","name":"backup-YYYY-MM-DD-engine"},"endpoints":[{"type":"read_only"}]}`. Do this before any destructive migration.
2. Keep backup branches; remove old ones deliberately (free plan: 10 branches). Neon's point-in-time history additionally allows restoring `main` to a recent timestamp (Console → Branches → Restore).

## Restore drill (verifies a backup can be restored)

1. Create a temporary branch from the backup branch (`parent_id` = backup branch id, read-only endpoint).
2. Compare both, read-only: `BACKUP_DRILL_SOURCE_URL=<backup uri> BACKUP_DRILL_TARGET_URL=<restore uri> node scripts/backup-drill.mjs`. It compares the schema version and, for every `music_*` table, the row count and an order-independent md5 digest of all rows, inside `READ ONLY, REPEATABLE READ` transactions. Exit 0 = identical, 2 = mismatch.
   - From an environment that cannot reach Neon directly, set those two variables on the engine's Render service and deploy: the engine runs the drill once at boot and logs one `{"event":"backup.drill",...}` line (no connection details). Remove both variables afterwards.
3. Delete only the temporary restore branch.

## Real restore

Point the engine at a restored branch by replacing `DATABASE_URL` with that branch's connection string (or restore `main` in place from the Neon console), deploy, and check `/health` and `/v1/summary`. Record the action in the audit notes below.

## Drill record

See `implementation-status.md` (2026-11-17 backup drill entry).
