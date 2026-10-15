-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 1 follow-up (task #51) — support and invitation windows are instants,
-- not wall-clock times.
--
-- Why this migration exists
-- ─────────────────────────────────────────────────────────────────────────────
-- `SupportAccessGrant.expiresAt` and `Invitation.expiresAt` were
-- `timestamp(3) WITHOUT TIME ZONE`. Prisma writes them as UTC instants, while
-- the database compares them against `now()`, which IS timezone-aware. In a
-- session that is not UTC the two disagree by the session offset: on a cluster
-- in `Africa/Nairobi` (+03) every window Prisma had created looked three hours
-- shorter, and a support grant that should still be live read as expired. That
-- is how the first harness run lost its support-grant rows — see
-- `docs/architecture/security-model.md` §13.7 and the harness report §4. The
-- harness has been pinning the disposable database to UTC to measure the
-- production posture; pinning a test rig is not a fix, and the operator's own
-- laptop, or any future replica with a different `log_timezone`/`timezone`,
-- stays exposed.
--
-- What changes
-- ─────────────────────────────────────────────────────────────────────────────
--   * SupportAccessGrant: expiresAt, revokedAt, createdAt -> timestamptz(3)
--   * Invitation:         expiresAt, acceptedAt           -> timestamptz(3)
--
-- `createdAt` moves with its table's window columns because two CHECKs compare
-- expiry and revocation against it; converting only one side would leave those
-- constraints resolving through the session timezone, which is the very defect
-- being removed. `Invitation.createdAt`/`updatedAt` stay as they are: nothing in
-- SQL compares them to an instant, and a security fix should not widen itself.
--
-- `USING <col> AT TIME ZONE 'UTC'` reads the stored naive value as UTC wall time
-- and converts it to the corresponding instant — correct for every value Prisma
-- wrote, and lossless for the data the fixtures create. A database whose content
-- was written by a non-UTC client would need a data review first; the live
-- project has no rows in either table today (it is still at migration 10 with
-- zero business data), so nothing here reinterprets real history.
--
-- The two `SupportAccessGrant` CHECKs are dropped and re-added with identical
-- names and definitions; only the column types underneath them change.
--
-- Verification performed (disposable cluster, never the shared project)
-- ─────────────────────────────────────────────────────────────────────
--   * a harness case that opens a session in `Africa/Nairobi` and reads the
--     granted workspace through the live grant — it measures 0 rows before this
--     migration and 1 row after, on the same fixture;
--   * `prisma migrate diff` between the migrated database and `schema.prisma`
--     reports no drift, and `pnpm db:generate` regenerates the client against the
--     new column types;
--   * the clean-room chain end to end, whose step 13 applies this migration on
--     top of 1–11 and re-runs the behaviour battery.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── SupportAccessGrant ────────────────────────────────────────────────────────
-- The CHECKs reference the columns being retyped, so they go first and come back
-- unchanged in name and meaning.
ALTER TABLE "SupportAccessGrant"
    DROP CONSTRAINT "SupportAccessGrant_expiry_is_after_creation",
    DROP CONSTRAINT "SupportAccessGrant_revocation_is_after_creation";

ALTER TABLE "SupportAccessGrant"
    ALTER COLUMN "expiresAt" TYPE timestamptz(3) USING "expiresAt" AT TIME ZONE 'UTC',
    ALTER COLUMN "revokedAt"  TYPE timestamptz(3) USING "revokedAt"  AT TIME ZONE 'UTC',
    ALTER COLUMN "createdAt"  TYPE timestamptz(3) USING "createdAt"  AT TIME ZONE 'UTC';

ALTER TABLE "SupportAccessGrant"
    ADD CONSTRAINT "SupportAccessGrant_expiry_is_after_creation"
        CHECK ("expiresAt" > "createdAt"),
    ADD CONSTRAINT "SupportAccessGrant_revocation_is_after_creation"
        CHECK ("revokedAt" IS NULL OR "revokedAt" >= "createdAt");

-- ── Invitation ────────────────────────────────────────────────────────────────
ALTER TABLE "Invitation"
    ALTER COLUMN "expiresAt"  TYPE timestamptz(3) USING "expiresAt"  AT TIME ZONE 'UTC',
    ALTER COLUMN "acceptedAt" TYPE timestamptz(3) USING "acceptedAt" AT TIME ZONE 'UTC';

COMMENT ON COLUMN "SupportAccessGrant"."expiresAt" IS
  'Instant the read-only support access stops being valid. `has_support_grant()` compares it to now(); it must stay timezone-independent (migration 20261021000001).';
COMMENT ON COLUMN "Invitation"."expiresAt" IS
  'Instant the pending invitation stops being acceptable. Timezone-independent since migration 20261021000001.';
