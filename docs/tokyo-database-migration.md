# Tokyo API and database migration

The target is a single writable PostgreSQL 16 instance, `salon-reserve-db-tokyo`, and API service `reservation-api` in `asia-northeast1`. The original `salon-reserve-db` must remain recoverable and must not receive application writes after cutover. The private chart-photo bucket stays in place; all database bytes, object references, generations, deletion tombstones, member links, idempotency records, rate counters, and audit records are part of the migration.

## Preparation without interrupting service

1. Verify the source instance, PostgreSQL version, private network, TLS, automated backups, and every writer. Take an additional on-demand backup and require `SUCCESSFUL`.
2. Create the Tokyo private subnet and additional Private Service Access range without replacing the existing range. Create the target instance with the same engine and capacity, private IP only, backups, and deletion protection.
3. Restore a backup into the unused target and verify its identity, schema, constraints, and table inspection. Measure this rehearsal to plan downtime. A backup taken while production runs is a rehearsal copy and must never become the final production state.
4. Create a separate, version-pinned Tokyo database secret. Grant access only to the API/schema and provisioning runtime identities. Keep the former secret for recovery; never change a shared `latest` reference to silently switch databases.
5. Test all application behavior against disposable PostgreSQL 16 using `cloudbuild.integration.yaml`. Test the legacy API relay and deployment/lease recovery separately. Build the final images before maintenance.

The source currently has point-in-time recovery disabled. Enabling it to create a cross-region replica would restart that live instance. The selected migration therefore uses a rehearsed backup/restore with a final write-free interval. The [Cloud SQL backup restoration procedure](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/restoring) supports a target in another region.

## Final cutover

1. Coordinate the maintenance window. Pause the automatic production trigger and manual provisioning workflow; confirm there is no active build, deployment lease, or job execution. Preserve their original enabled state. Acquire the existing deployment lease object with `ifGenerationMatch=0` as an explicit operator-owned `databaseMigration` lease. Native builds must fail closed on this owner rather than reclaim it automatically. Record the migration ID and object generation; release only after ownership and generation/metageneration still match.
2. Put the old API into maintenance using the DB-free relay. Fence **all** business methods, including GET: staff authentication updates `AppUser`, and reading a chart photo creates an audit event. Keep the new API unavailable to users until the final target is verified.
3. Retire old writer jobs or make them fail closed without a database secret. Remove old API traffic tags. Drain in-flight requests, including photo writes and cleanup, for at least the configured request timeout. A timed-out Cloud Run request can keep processing, so timeout expiry and an empty transaction list alone are insufficient. Run `scripts/db-migration-control.mjs fence-source` with the source secret: it checks database `reservation` and server `10.90.0.3`, sets the database default to read-only, terminates other application-user sessions in that database, and uses a fresh connection to prove a persistent-table INSERT is rejected with SQLSTATE `25006`. Verify no other database users are application writers and no active application transactions remain.
4. Capture a read-only, repeatable-read source fingerprint and final successful backup while every writer is fenced. Retain the source and backup. Stop the former database once the backup is complete to prevent stale revisions or manual callers from creating split writes. After restore, use `scripts/db-migration-control.mjs unfence-target` to clear the inherited read-only default on the guarded Tokyo address `10.91.0.3` only, then `probe-target` to verify an INSERT that is always rolled back; never clear the source fence after Tokyo accepts writes.
5. Restore the final backup into the unused Tokyo target. If the rehearsal copy already matches the frozen source in every field listed below, a fresh target inspection taken after source fencing may establish that the final restore is unnecessary; retain the final successful source backup and all writer fences in either case. Compare `tableCount`, every table's count/checksum, `dataChecksum`, `schemaChecksum`, `sequenceChecksum`, and integrity counters against the frozen source. Any difference requires the final restore and a new full comparison. Never compare identity, size, WAL position, or snapshot time for equality: those legitimately differ.
6. Verify the Tokyo instance is a primary and is not default-read-only. Perform a synthetic persistent-table INSERT inside a transaction that is always rolled back; a temporary-table write or `SELECT 1` does not prove writability. Run `scripts/db-migration-control.mjs analyze-target` to refresh all public-table planner statistics on the guarded Tokyo database. Recheck hashes after the probe and statistics refresh. Take a target backup.
7. Deploy the same verified API image and schema job using the Tokyo subnet and fixed Tokyo secret. Verify revision digest, runtime identity, readiness, and traffic. Switch the legacy relay to normal mode, then deploy the web build targeting Tokyo directly. The old API must proxy, not redirect, because existing member clients reject redirects and preserve pending-booking idempotency keys under their original API origin.
8. Verify old and new API authentication boundaries, CORS, paths, bodies, and absence of redirect responses; verify frontend login/assets and old frontend redirects. Confirm all production writers use Tokyo. Re-enable the trigger and provisioning workflow only after their configuration is safe.

## Fingerprints and evidence

`scripts/db-migration-inspect.mjs` runs inside the API image with a Secret Manager connection. It returns counts and SHA-256 hashes rather than row contents. It includes every public table and schema/constraint/index/sequence metadata. The transaction is READ ONLY and REPEATABLE READ, with fixed date/byte formatting and RLS bypass checks that fail closed when a complete view is unavailable. Sequence state is not MVCC; the script detects changes during inspection, but only external writer fencing protects the final snapshot.

Use `DB_INSPECTION_EXPECTED_DATABASE=reservation` and `DB_INSPECTION_MIN_TABLES=33`. Use `DB_INSPECTION_REQUIRE_PRIMARY=1` for the target after its read-only state is cleared. Retain the original and final backup IDs, operation IDs, source/target fingerprints, test build, image digests, active revisions/traffic, and commit SHA as evidence. Never save database URLs, tokens, row values, or clinical images in Git or build logs.

## Recovery

Before the Tokyo database accepts any application write, recovery to the original database requires both API paths and jobs to remain fenced, proof that the target remained unused, and stopping the target. Restart the original database, then explicitly clear its inherited database-level read-only default using a source-identity-checked administrative session before restoring the old API revision. The migration controller intentionally has no source-unfence mode. Verify the original database is writable and that only its writers can run before restoring the trigger/workflow.

After Tokyo accepts writes, **do not switch back to the old database snapshot**. Prefer rolling back application images while continuing to use the Tokyo database and pinned secret. A region rollback then requires another fenced backup/restore or verified reverse synchronization of the current Tokyo data. Keep the original database stopped with deletion protection and retain both backups until recovery retention is explicitly reviewed. Do not delete it as part of cutover cleanup.

## Production cutover record — 2026-10-23

The API cutover completed at 09:43 JST after approximately six minutes of maintenance. All 33 public tables (3,983 rows), table contents, schema, sequences, and integrity counters matched between the frozen source and a fresh Tokyo inspection taken after source fencing. The rehearsal copy was therefore current and did not require a second restore. A persistent-table write probe was rolled back, and refreshing statistics left every fingerprint unchanged.

- Final frozen-source backup: `salon-reserve-db` / `1792715990050`, successful.
- Verified Tokyo backup before opening service: `salon-reserve-db-tokyo` / `1792716087664`, successful.
- Former database: `activationPolicy=NEVER`, database default read-only enabled, deletion protection retained. Its three former business jobs have no database secret or VPC attachment and fail closed.
- Tokyo database: private IP `10.91.0.3`, PostgreSQL 16, TLS connections, seven automated backups retained, deletion protection enabled.
- The old API origin proxies to Tokyo without redirects; the original frontend redirect remains in place.

The PostgreSQL integration build `9ff13338-6eca-4ede-99be-6f1abe774a6e` passed all 145 integration tests and the migration-control/fingerprint checks. The deployment control suite passed 115 tests. These results cover the cutover tooling; subsequent production builds must still verify their own commit, images, active revisions, and traffic.
