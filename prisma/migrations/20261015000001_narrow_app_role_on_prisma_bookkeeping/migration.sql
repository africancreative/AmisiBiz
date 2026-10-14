-- The blanket `ALTER DEFAULT PRIVILEGES ... GRANT SELECT, INSERT, UPDATE,
-- DELETE ON TABLES TO amisibiz_app` from 20261013000001 applies to every table
-- created afterwards in `public` — including Prisma's own `_prisma_migrations`
-- bookkeeping table, which `prisma migrate deploy` creates before applying any
-- migration. The application role has no business reading or rewriting
-- migration history, so take those privileges back.
--
-- Conditional because migrations applied through raw SQL (the offline
-- verification procedure) never create the table, and this migration must
-- apply cleanly either way. A separate migration rather than an amendment of
-- the applied chain — editing an applied migration would break
-- `_prisma_migrations` checksums.
DO $$
BEGIN
    IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
        EXECUTE 'REVOKE ALL ON public._prisma_migrations FROM amisibiz_app';
    END IF;
END
$$;
