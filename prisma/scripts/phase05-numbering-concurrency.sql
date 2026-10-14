-- Phase 05 check 19: concurrent document number allocation.
--
-- WHY THIS IS A SEPARATE FILE: the guarantee under test is that two transactions
-- allocating from the same series cannot receive the same number. That is
-- unobservable from one connection, so this script is designed to be launched as
-- two (or twenty) simultaneous `psql` processes against the same scratch
-- database:
--
--   psql -v ON_ERROR_STOP=1 -q -d <scratch> -f prisma/scripts/phase05-numbering-concurrency.sql &
--   psql -v ON_ERROR_STOP=1 -q -d <scratch> -f prisma/scripts/phase05-numbering-concurrency.sql &
--   wait
--
-- WHAT EACH SESSION DOES: allocates ten invoice numbers for one tenant and
-- commits an ISSUED invoice carrying each one, in the same transaction as the
-- allocation. If `allocate_document_number()` did not lock the counter row, both
-- sessions would read the same `nextValue` and the second one would die on the
-- unique index — the failure mode the lock exists to prevent. The numbers each
-- session prints are its own; the report at the end is the global state, and
-- since both sessions serialise on the lock, the session that finishes last
-- prints the settled picture: twenty documents, twenty distinct numbers with no
-- gaps, and a counter that advanced exactly twenty times.
--
-- SCRATCH ONLY: like the checks script, this leaves committed rows behind and
-- must never be pointed at a real database.
\pset footer off

-- ── bootstrap (own transaction, idempotent, so concurrent sessions can both
--    run it; ON CONFLICT makes the loser of the race a no-op) ─────────────────
BEGIN;
INSERT INTO "Tenant" ("id","name","slug","currency")
  VALUES ('tenantnum0040000000000001','Series Parallel','series-parallel','KES')
  ON CONFLICT ("id") DO NOTHING;
INSERT INTO "User" ("id","email","name","platformRole","status")
  VALUES ('actor-1','actor@example.invalid','Issuer One','USER','ACTIVE')
  ON CONFLICT ("id") DO NOTHING;
INSERT INTO "Contact" ("id","tenantId","type","firstName")
  VALUES ('c-conc','tenantnum0040000000000001','INDIVIDUAL','Cass')
  ON CONFLICT ("id") DO NOTHING;
COMMIT;

-- ── ten allocations, each issued in the transaction that took it ─────────────
\echo '-- allocating and issuing ten invoices in this session'
BEGIN;
DO $$
DECLARE
    v_number text;
    i        integer;
BEGIN
    FOR i IN 1..10 LOOP
        v_number := allocate_document_number('tenantnum0040000000000001','INVOICE',
                                             DATE '2026-04-05');
        INSERT INTO "Document" ("id","tenantId","type","status","number","contactId",
                                "dueDate","issuedAt","issuedById","snapshot","snapshotAt")
             VALUES ('conc-' || pg_backend_pid() || '-' || lpad(i::text, 2, '0'),
                     'tenantnum0040000000000001','INVOICE','ISSUED', v_number,'c-conc',
                     DATE '2026-05-05', now(),'actor-1','{}'::jsonb, now());
    END LOOP;
END;
$$;
COMMIT;

-- ── this session's own take ──────────────────────────────────────────────────
SELECT '19. session ' || pg_backend_pid() || ' issued these numbers' AS check,
       string_agg("number", ' ' ORDER BY "number") AS numbers,
       count(*) AS documents
FROM "Document"
WHERE "id" LIKE 'conc-' || pg_backend_pid() || '-%';

-- ── global report: duplicates and gaps would be visible here ─────────────────
SELECT '19. series state after this session committed' AS check,
       count(DISTINCT d."number") AS distinct_numbers,
       count(*) AS documents,
       min(d."number") AS first_number,
       max(d."number") AS last_number,
       max(s."nextValue") - 1 AS highest_allocated
FROM "Document" d
JOIN "DocumentNumberSequence" s
  ON s."tenantId" = d."tenantId" AND s."type" = d."type" AND s."period" = '2026'
WHERE d."tenantId" = 'tenantnum0040000000000001';
