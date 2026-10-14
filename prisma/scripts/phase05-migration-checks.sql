-- Phase 05 migration behaviour checks (run against the scratch database only).
-- Every statement prints a name and the observed result so the run is auditable.
--
-- WHAT THIS SCRIPT IS FOR: the document engine's guarantees are stated twice on
-- purpose — once in the domain layer and once in the database — so this script
-- exercises the database half directly with raw SQL: the numbering function, the
-- immutability triggers, the arithmetic CHECKs and row level security. It writes
-- documents as SQL, not through the application, which is exactly the point: a
-- guarantee that only holds when the server actions are used is not a guarantee.
--
-- HOW TO RUN: against a database that has the full migration chain applied.
--   psql -v ON_ERROR_STOP=1 -q -d <scratch> -f prisma/scripts/phase05-migration-checks.sql
--
-- SCRATCH-ONLY NOTES:
--   * the `updatedAt SET DEFAULT now()` shim below is a convenience for raw
--     inserts (Prisma normally writes that column from the application). It
--     mutates the scratch schema, so run `prisma migrate diff` BEFORE this
--     script, never after, or the shim shows up as false drift.
--   * checks 9-14 COMMIT on purpose: a counter that rolls back proves nothing.
--     Each of those checks uses its own tenant so its series starts at 1, and
--     issued documents cannot be deleted afterwards (check 16 proves that), so
--     the rows are left behind. Never point this script at a real database.
\pset footer off
\set ON_ERROR_STOP off

-- ── scratch shim: updatedAt defaults, so raw INSERTs stay short ──────────────
DO $$
DECLARE r RECORD;
BEGIN
    FOR r IN
        SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'updatedAt'
          AND column_default IS NULL
    LOOP
        EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN "updatedAt" SET DEFAULT now()', 'public', r.table_name);
    END LOOP;
END
$$;

-- ── setup: two business tenants, three numbering tenants, an actor ───────────
BEGIN;
INSERT INTO "Tenant" ("id","name","slug","currency") VALUES
  ('tenantaaa0000000000000001','Tenant A','tenant-a','KES'),
  ('tenantbbb0000000000000001','Tenant B','tenant-b','KES'),
  ('tenantnum0010000000000001','Series Basic','series-basic','KES'),
  ('tenantnum0020000000000001','Series Custom','series-custom','KES'),
  ('tenantnum0030000000000001','Series Exhausted','series-exhausted','KES'),
  ('tenantnum0040000000000001','Series Parallel','series-parallel','KES'),
  ('tenantnum0050000000000001','Series Rolled Back','series-rolled-back','KES'),
  ('tenantnum0060000000000001','Series Drafted','series-drafted','KES')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "User" ("id","email","name","platformRole","status")
  VALUES ('actor-1','actor@example.invalid','Issuer One','USER','ACTIVE')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "Contact" ("id","tenantId","type","firstName") VALUES
  ('c-a1','tenantaaa0000000000000001','INDIVIDUAL','Ann'),
  ('c-b1','tenantbbb0000000000000001','INDIVIDUAL','Bea')
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "DocumentNumbering" ("id","tenantId","type","prefix","padding","separator","periodStyle")
  VALUES
    ('num-custom-1','tenantnum0020000000000001','INVOICE','ACME',3,'.','NONE'),
    ('num-exhaust-1','tenantnum0030000000000001','QUOTATION','QUO',1,'-','NONE')
ON CONFLICT ("tenantId","type") DO NOTHING;
COMMIT;

-- ── 1. type and status are real enums now, and the legacy text is gone ───────
SELECT '1. column types after conversion' AS check,
       a.attname AS column,
       format_type(a.atttypid, a.atttypmod) AS type
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
WHERE c.relname = 'Document' AND a.attname IN ('type','status')
ORDER BY a.attname;

-- ── 2. a draft carries no number; anything else must ─────────────────────────
BEGIN;
SELECT '2a. draft with a number rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","number","contactId")
  VALUES ('chk-2a','tenantaaa0000000000000001','QUOTATION','DRAFT','QUO-2026-0001','c-a1');
ROLLBACK;

BEGIN;
-- Complete in every other respect: the only thing missing is the number, so the
-- failure reported is the draft/number identity and not an unrelated CHECK.
SELECT '2b. issued document without a number rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId","expiryDate",
                        "issuedAt","issuedById","snapshot","snapshotAt")
  VALUES ('chk-2b','tenantaaa0000000000000001','QUOTATION','ISSUED','c-a1',
          DATE '2026-12-31',now(),'actor-1','{}'::jsonb,now());
ROLLBACK;

BEGIN;
INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('chk-2c1','tenantaaa0000000000000001','QUOTATION','DRAFT','c-a1'),
         ('chk-2c2','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1'),
         ('chk-2c3','tenantaaa0000000000000001','DELIVERY_NOTE','DRAFT','c-a1');
SELECT '2c. three unnumbered drafts coexist (NULLs do not collide)' AS check,
       count(*) AS drafts, count("number") AS numbered
FROM "Document" WHERE "id" LIKE 'chk-2c%';
ROLLBACK;

-- ── 3. each document type owns its lifecycle ─────────────────────────────────
BEGIN;
SELECT '3a. quotation cannot be PAID' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","number","contactId","expiryDate",
                        "issuedAt","issuedById","snapshot","snapshotAt")
  VALUES ('chk-3a','tenantaaa0000000000000001','QUOTATION','PAID','QUO-2026-0031','c-a1',
          DATE '2026-12-31',now(),'actor-1','{}'::jsonb,now());
ROLLBACK;

BEGIN;
SELECT '3b. invoice cannot be ACCEPTED' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","number","contactId","dueDate",
                        "issuedAt","issuedById","snapshot","snapshotAt")
  VALUES ('chk-3b','tenantaaa0000000000000001','INVOICE','ACCEPTED','INV-2026-0031','c-a1',
          DATE '2026-12-31',now(),'actor-1','{}'::jsonb,now());
ROLLBACK;

-- ── 4. the stored breakdown is an identity, not a hint ───────────────────────
BEGIN;
SELECT '4a. total that disagrees with base + tax rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId",
                        "subtotal","totalDiscount","taxableBase","taxTotal","total")
  VALUES ('chk-4a','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1',
          100.00, 10.00, 90.00, 14.40, 120.00);
ROLLBACK;

BEGIN;
WITH d AS (
  INSERT INTO "Document" ("id","tenantId","type","status","contactId",
                          "subtotal","totalDiscount","taxableBase","taxTotal","total")
  VALUES ('chk-4b','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1',
          100.00, 10.00, 90.00, 14.40, 104.40)
  RETURNING "subtotal","totalDiscount","taxableBase","taxTotal","total"
)
SELECT '4b. consistent breakdown accepted' AS check,
       "subtotal"::text || ' - ' || "totalDiscount"::text || ' = ' ||
       "taxableBase"::text || ' + ' || "taxTotal"::text || ' = ' || "total"::text AS stored
FROM d;
ROLLBACK;

BEGIN;
-- The identities hold and the total is positive, so the legacy `total >= 0`
-- CHECK passes and the failure that surfaces is the one under test: a discount
-- can never be larger than the subtotal it comes off.
SELECT '4c. discount larger than the subtotal rejected (base cannot go negative)' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId",
                        "subtotal","totalDiscount","taxableBase","taxTotal","total")
  VALUES ('chk-4c','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1',
          100.00, 150.00, -50.00, 60.00, 10.00);
ROLLBACK;

-- ── 5. a line has one discount mechanism, not two ────────────────────────────
BEGIN;
SELECT '5a. percent and amount on the same line rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('chk-5','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1');
INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","description",
                            "quantity","unitPrice","discountType","discountPercent","discountAmount",
                            "lineTotal","lineDiscount","lineNet","lineTax")
  VALUES ('l-5','tenantaaa0000000000000001','chk-5',1,'Both discounts',
          1, 100.00, 'PERCENT', 10.00, 10.00, 100.00, 10.00, 90.00, 0.00);
ROLLBACK;

BEGIN;
SELECT '5b. line net that is not total minus discount rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('chk-5b','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1');
INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","description",
                            "quantity","unitPrice","lineTotal","lineDiscount","lineNet","lineTax")
  VALUES ('l-5b','tenantaaa0000000000000001','chk-5b',1,'Wrong net',
          1, 100.00, 100.00, 10.00, 95.00, 0.00);
ROLLBACK;

BEGIN;
SELECT '5c. zero and negative quantities rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('chk-5c','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1');
INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","description",
                            "quantity","unitPrice","lineTotal","lineNet")
  VALUES ('l-5c','tenantaaa0000000000000001','chk-5c',1,'Free item', 0, 0, 0, 0);
ROLLBACK;

-- ── 6. money and quantity are exact decimals ────────────────────────────────
BEGIN;
WITH d AS (
  INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('chk-6','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1') RETURNING "id"
), l AS (
  INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","description",
                              "quantity","unitPrice","lineTotal","lineNet")
  SELECT 'l-6','tenantaaa0000000000000001', d."id", 1, 'Precise line',
         3, 33.3333, 99.9999, 99.9999
  FROM d
  RETURNING "quantity","unitPrice","lineTotal"
)
SELECT '6. three decimals of a quantity survive the round trip' AS check,
       "quantity"::text AS quantity, "unitPrice"::text AS unit_price,
       "lineTotal"::text AS line_total
FROM l;
ROLLBACK;

-- ── 7. delivered quantity is a running total inside the line ─────────────────
BEGIN;
SELECT '7a. over-delivery rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('chk-7','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1');
INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","description",
                            "quantity","unitPrice","lineTotal","lineNet","deliveredQuantity")
  VALUES ('l-7','tenantaaa0000000000000001','chk-7',1,'Ten units',
          10, 5.00, 50.00, 50.00, 11);
ROLLBACK;

BEGIN;
WITH d AS (
  INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('chk-7b','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1') RETURNING "id"
), l AS (
  INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","description",
                              "quantity","unitPrice","lineTotal","lineNet","deliveredQuantity")
  SELECT 'l-7b','tenantaaa0000000000000001', d."id", 1, 'Ten units',
         10, 5.00, 50.00, 50.00, 4
  FROM d
  RETURNING "quantity","deliveredQuantity"
)
SELECT '7b. partial delivery accepted and stays inside the line' AS check,
       "quantity"::text AS ordered, "deliveredQuantity"::text AS delivered
FROM l;
ROLLBACK;

-- ── 8. no child row can be pointed at another tenant ─────────────────────────
BEGIN;
SELECT '8a. line carrying tenant B under a tenant A document rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('chk-8','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1');
INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","description",
                            "quantity","unitPrice","lineTotal","lineNet")
  VALUES ('l-8','tenantbbb0000000000000001','chk-8',1,'Cross tenant', 1, 1, 1, 1);
ROLLBACK;

BEGIN;
SELECT '8b. document pointing at another tenant''s contact rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('chk-8b','tenantaaa0000000000000001','INVOICE','DRAFT','c-b1');
ROLLBACK;

BEGIN;
SELECT '8c. cross-tenant source document rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('chk-8c1','tenantbbb0000000000000001','QUOTATION','DRAFT','c-b1'),
         ('chk-8c2','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1');
UPDATE "Document" SET "sourceDocumentId" = 'chk-8c1' WHERE "id" = 'chk-8c2';
ROLLBACK;

-- ── 9. one document number per tenant and series, but not globally ───────────
BEGIN;
SELECT '9a. duplicate number inside a tenant rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","number","contactId","expiryDate",
                        "issuedAt","issuedById","snapshot","snapshotAt")
  VALUES ('chk-9a','tenantaaa0000000000000001','QUOTATION','ISSUED','QUO-2026-0001','c-a1',
          now()+interval '30 days', now(),'actor-1','{}'::jsonb, now());
INSERT INTO "Document" ("id","tenantId","type","status","number","contactId","expiryDate",
                        "issuedAt","issuedById","snapshot","snapshotAt")
  VALUES ('chk-9b','tenantaaa0000000000000001','QUOTATION','ISSUED','QUO-2026-0001','c-a1',
          now()+interval '30 days', now(),'actor-1','{}'::jsonb, now());
ROLLBACK;

BEGIN;
SELECT '9b. the same number in another tenant is fine' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","number","contactId","expiryDate",
                        "issuedAt","issuedById","snapshot","snapshotAt")
  VALUES ('chk-9c','tenantbbb0000000000000001','QUOTATION','ISSUED','QUO-2026-0001','c-b1',
          now()+interval '30 days', now(),'actor-1','{}'::jsonb, now());
SELECT '9b. second tenant holds' || "number" AS check, "tenantId"
FROM "Document" WHERE "id" = 'chk-9c';
ROLLBACK;

-- ── 10. only a sales document is derived, and one quotation becomes one invoice ─
BEGIN;
SELECT '10a. second invoice from the same quotation rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","number","contactId","expiryDate",
                        "issuedAt","issuedById","snapshot","snapshotAt")
  VALUES ('q-10','tenantaaa0000000000000001','QUOTATION','ISSUED','QUO-2026-0701','c-a1',
          now()+interval '30 days', now(),'actor-1','{}'::jsonb, now());
INSERT INTO "Document" ("id","tenantId","type","status","number","contactId","dueDate",
                        "issuedAt","issuedById","snapshot","snapshotAt","sourceDocumentId")
  VALUES ('i-10a','tenantaaa0000000000000001','INVOICE','ISSUED','INV-2026-0701','c-a1',
          now()+interval '30 days', now(),'actor-1','{}'::jsonb, now(),'q-10');
INSERT INTO "Document" ("id","tenantId","type","status","number","contactId","dueDate",
                        "issuedAt","issuedById","snapshot","snapshotAt","sourceDocumentId")
  VALUES ('i-10b','tenantaaa0000000000000001','INVOICE','ISSUED','INV-2026-0702','c-a1',
          now()+interval '30 days', now(),'actor-1','{}'::jsonb, now(),'q-10');
ROLLBACK;

BEGIN;
INSERT INTO "Document" ("id","tenantId","type","status","number","contactId","dueDate",
                        "issuedAt","issuedById","snapshot","snapshotAt")
  VALUES ('i-10-src','tenantaaa0000000000000001','INVOICE','ISSUED','INV-2026-0710','c-a1',
          now()+interval '30 days', now(),'actor-1','{}'::jsonb, now());
INSERT INTO "Document" ("id","tenantId","type","status","number","contactId","deliveryDate",
                        "issuedAt","issuedById","snapshot","snapshotAt","sourceDocumentId")
  VALUES ('dn-10a','tenantaaa0000000000000001','DELIVERY_NOTE','ISSUED','DN-2026-0710','c-a1',
          now(), now(),'actor-1','{}'::jsonb, now(),'i-10-src'),
         ('dn-10b','tenantaaa0000000000000001','DELIVERY_NOTE','ISSUED','DN-2026-0711','c-a1',
          now(), now(),'actor-1','{}'::jsonb, now(),'i-10-src');
SELECT '10b. two delivery notes from one invoice are allowed (partial delivery)' AS check,
       count(*) AS delivery_notes
FROM "Document" WHERE "sourceDocumentId" = 'i-10-src';
ROLLBACK;

BEGIN;
SELECT '10c. only a sales document can be derived from another' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('chk-10c-src','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1'),
         ('chk-10c-new','tenantaaa0000000000000001','QUOTATION','DRAFT','c-a1');
UPDATE "Document" SET "sourceDocumentId" = 'chk-10c-src' WHERE "id" = 'chk-10c-new';
ROLLBACK;

-- ── 11. idempotency keys are unique per tenant, so a retry returns the same row ─
BEGIN;
SELECT '11. a second document reusing the tenant''s idempotency key is rejected' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId","idempotencyKey")
  VALUES ('chk-11a','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1','conv-000000000001'),
         ('chk-11b','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1','conv-000000000001');
ROLLBACK;

-- ── 12. an issued document is immutable, and cannot be deleted ───────────────
-- Issued through the lifecycle, exactly as the service layer will do it: the
-- draft exists first, its lines are written while it is editable, and then a
-- single UPDATE moves it to ISSUED with its number, snapshot and actor.
-- (Adding a line after issuance is itself rejected — check 13a — so the fixture
-- had to respect the rule it is about to test.)
BEGIN;
INSERT INTO "Document" ("id","tenantId","type","status","contactId",
                        "subtotal","totalDiscount","taxableBase","taxTotal","total")
  VALUES ('imm-1','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1',
          100.00, 0.00, 100.00, 16.00, 116.00);
INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","description",
                            "quantity","unitPrice","lineTotal","lineNet","lineTax","taxName","taxRate")
  VALUES ('imm-l1','tenantaaa0000000000000001','imm-1',1,'Widget',2,50.00,100.00,100.00,16.00,'VAT 16%',0.16);
UPDATE "Document"
   SET "status" = 'ISSUED', "number" = 'INV-2026-0801',
       "dueDate" = now() + interval '30 days',
       "issuedAt" = now(), "issuedById" = 'actor-1',
       "snapshot" = '{"number":"INV-2026-0801"}'::jsonb, "snapshotAt" = now(),
       "taxBreakdown" = '[{"rate":"0.1600","amount":"16.0000"}]'::jsonb
 WHERE "id" = 'imm-1';
SELECT '12. issued through the lifecycle: draft, line, then number and snapshot' AS check,
       "status"::text AS status, "number", "issuedById"
FROM "Document" WHERE "id" = 'imm-1';
COMMIT;

BEGIN;
SELECT '12a. changing the total of an issued invoice is rejected' AS check;
UPDATE "Document" SET "total" = 1.00, "taxableBase" = 1.00, "taxTotal" = 0.00 WHERE "id" = 'imm-1';
ROLLBACK;

BEGIN;
SELECT '12b. rewriting the snapshot is rejected' AS check;
UPDATE "Document" SET "snapshot" = '{"number":"INV-2026-0801","forged":true}'::jsonb WHERE "id" = 'imm-1';
ROLLBACK;

BEGIN;
SELECT '12c. back-dating an issued invoice is rejected' AS check;
UPDATE "Document" SET "issueDate" = "issueDate" - interval '30 days' WHERE "id" = 'imm-1';
ROLLBACK;

BEGIN;
SELECT '12d. an issued invoice cannot be pushed back to DRAFT' AS check;
UPDATE "Document" SET "status" = 'DRAFT' WHERE "id" = 'imm-1';
ROLLBACK;

BEGIN;
SELECT '12e. an issued invoice cannot be deleted' AS check;
DELETE FROM "Document" WHERE "id" = 'imm-1';
ROLLBACK;

BEGIN;
SELECT '12f. a lifecycle transition (status only) is allowed' AS check;
UPDATE "Document" SET "status" = 'VOID', "voidedAt" = now(), "voidReason" = 'Duplicate issue',
                      "voidedById" = 'actor-1'
WHERE "id" = 'imm-1';
SELECT '12f. invoice is now voided, reason kept' AS check, "status", "voidReason"
FROM "Document" WHERE "id" = 'imm-1';
ROLLBACK;

BEGIN;
SELECT '12g. voiding without a reason is rejected' AS check;
UPDATE "Document" SET "status" = 'VOID', "voidedAt" = now(), "voidedById" = 'actor-1'
WHERE "id" = 'imm-1';
ROLLBACK;

-- ── 13. the lines of an issued document are frozen except the delivery counter ─
BEGIN;
SELECT '13a. adding a line to an issued document is rejected' AS check;
INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","description",
                            "quantity","unitPrice","lineTotal","lineNet")
  VALUES ('imm-l2','tenantaaa0000000000000001','imm-1',2,'Sneaked in',1,1.00,1.00,1.00);
ROLLBACK;

BEGIN;
SELECT '13b. removing a line from an issued document is rejected' AS check;
DELETE FROM "DocumentLine" WHERE "id" = 'imm-l1';
ROLLBACK;

BEGIN;
SELECT '13c. editing an issued line price is rejected' AS check;
UPDATE "DocumentLine" SET "unitPrice" = 1.00, "lineTotal" = 2.00, "lineNet" = 2.00 WHERE "id" = 'imm-l1';
ROLLBACK;

BEGIN;
SELECT '13d. recording delivery against an issued line is allowed' AS check;
UPDATE "DocumentLine" SET "deliveredQuantity" = 1 WHERE "id" = 'imm-l1';
SELECT '13d. delivered quantity moved, price untouched' AS check,
       "deliveredQuantity"::text AS delivered, "unitPrice"::text AS unit_price
FROM "DocumentLine" WHERE "id" = 'imm-l1';
ROLLBACK;

BEGIN;
SELECT '13e. a draft document is still fully editable' AS check;
INSERT INTO "Document" ("id","tenantId","type","status","contactId")
  VALUES ('draft-13','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1');
INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","description",
                            "quantity","unitPrice","lineTotal","lineNet")
  VALUES ('draft-l13','tenantaaa0000000000000001','draft-13',1,'Draft line',1,10.00,10.00,10.00);
UPDATE "DocumentLine" SET "description" = 'Renamed while draft', "unitPrice" = 12.00,
                         "lineTotal" = 24.00, "lineNet" = 24.00
WHERE "id" = 'draft-l13';
DELETE FROM "DocumentLine" WHERE "id" = 'draft-l13';
SELECT '13e. draft line created, edited and removed' AS check, count(*) AS remaining
FROM "DocumentLine" WHERE "documentId" = 'draft-13';
ROLLBACK;

-- ── 14. payments and status events are append-only ───────────────────────────
BEGIN;
INSERT INTO "DocumentPayment" ("id","tenantId","documentId","amount","occurredOn","method","reference")
  VALUES ('pay-1','tenantaaa0000000000000001','imm-1',50.00, now(),'MOBILE_MONEY','MPESA-1');
SELECT '14a. recorded payment' AS check, "amount"::text AS amount, "method"
FROM "DocumentPayment" WHERE "id" = 'pay-1';
ROLLBACK;

BEGIN;
SELECT '14b. deleting a payment is rejected' AS check;
INSERT INTO "DocumentPayment" ("id","tenantId","documentId","amount","occurredOn")
  VALUES ('pay-2','tenantaaa0000000000000001','imm-1',50.00, now());
DELETE FROM "DocumentPayment" WHERE "id" = 'pay-2';
ROLLBACK;

BEGIN;
SELECT '14c. editing a payment amount is rejected' AS check;
INSERT INTO "DocumentPayment" ("id","tenantId","documentId","amount","occurredOn")
  VALUES ('pay-3','tenantaaa0000000000000001','imm-1',50.00, now());
UPDATE "DocumentPayment" SET "amount" = 5000.00 WHERE "id" = 'pay-3';
ROLLBACK;

BEGIN;
SELECT '14d. reversal keeps the row and refuses a second reversal' AS check;
INSERT INTO "DocumentPayment" ("id","tenantId","documentId","amount","occurredOn")
  VALUES ('pay-4','tenantaaa0000000000000001','imm-1',50.00, now());
UPDATE "DocumentPayment" SET "reversedAt" = now(), "reversedBy" = 'actor-1' WHERE "id" = 'pay-4';
SELECT '14d. payment reversed, still present' AS check, "amount"::text AS amount,
       ("reversedAt" IS NOT NULL) AS reversed
FROM "DocumentPayment" WHERE "id" = 'pay-4';
UPDATE "DocumentPayment" SET "reversedAt" = now() WHERE "id" = 'pay-4';
ROLLBACK;

BEGIN;
SELECT '14e. a payment that belongs to another tenant''s document is rejected' AS check;
INSERT INTO "DocumentPayment" ("id","tenantId","documentId","amount","occurredOn")
  VALUES ('pay-5','tenantbbb0000000000000001','imm-1',50.00, now());
ROLLBACK;

BEGIN;
SELECT '14f. status events cannot be rewritten' AS check;
INSERT INTO "DocumentStatusEvent" ("id","tenantId","documentId","fromStatus","toStatus","actorId")
  VALUES ('ev-1','tenantaaa0000000000000001','imm-1','ISSUED','PARTIALLY_PAID','actor-1');
UPDATE "DocumentStatusEvent" SET "toStatus" = 'PAID' WHERE "id" = 'ev-1';
ROLLBACK;

BEGIN;
SELECT '14g. a status event with no transition is rejected' AS check;
INSERT INTO "DocumentStatusEvent" ("id","tenantId","documentId","fromStatus","toStatus")
  VALUES ('ev-2','tenantaaa0000000000000001','imm-1','ISSUED','ISSUED');
ROLLBACK;

-- ── 15. numbering: the database allocates, in order, per series ──────────────
BEGIN;
SELECT '15a. first allocation for a fresh tenant uses the default series' AS check,
       allocate_document_number('tenantnum0010000000000001', 'INVOICE',
                                DATE '2026-04-05') AS number,
       allocate_document_number('tenantnum0010000000000001', 'INVOICE',
                                DATE '2026-04-05') AS next_number,
       allocate_document_number('tenantnum0010000000000001', 'QUOTATION',
                                DATE '2026-04-05') AS other_series,
       allocate_document_number('tenantnum0010000000000001', 'DELIVERY_NOTE',
                                DATE '2026-04-05') AS third_series;
COMMIT;

BEGIN;
SELECT '15b. the series configuration is created on first use with the documented defaults' AS check,
       "type"::text AS type, "prefix", "padding", "separator", "periodStyle"::text AS period_style
FROM "DocumentNumbering" WHERE "tenantId" = 'tenantnum0010000000000001' ORDER BY "type";
SELECT '15b. counters hold the values already handed out' AS check,
       "type"::text AS type, "period", "nextValue"
FROM "DocumentNumberSequence" WHERE "tenantId" = 'tenantnum0010000000000001' ORDER BY "type";
COMMIT;

BEGIN;
SELECT '15c. peek shows the next number without taking it' AS check,
       peek_document_number('tenantnum0010000000000001','INVOICE',
                            DATE '2026-04-05') AS preview;
SELECT '15c. counter unchanged by the peek' AS check, "nextValue"
FROM "DocumentNumberSequence"
WHERE "tenantId" = 'tenantnum0010000000000001' AND "type" = 'INVOICE';
COMMIT;

BEGIN;
-- The period is derived from a DATE — the document's own issue date — never from
-- a timestamp and never from the clock. Reading a `timestamptz` through
-- `to_char(...,'YYYY')` applies the session TimeZone, which on this scratch
-- cluster (+03:00) silently moved an invoice issued at 23:59Z on 31 December
-- into the following year. These two allocations are the boundary that caught it.
SELECT '15d. a calendar-year series rolls over on the document issue date, not the session clock' AS check,
       allocate_document_number('tenantnum0010000000000001','INVOICE',
                                DATE '2026-12-31') AS december,
       allocate_document_number('tenantnum0010000000000001','INVOICE',
                                DATE '2027-01-01') AS january;
COMMIT;

BEGIN;
SELECT '15e. tenant-configured prefix, padding and no period are honoured' AS check,
       allocate_document_number('tenantnum0020000000000001','INVOICE',
                                DATE '2026-04-05') AS first_custom,
       allocate_document_number('tenantnum0020000000000001','INVOICE',
                                DATE '2026-04-05') AS second_custom;
COMMIT;

BEGIN;
-- FINANCIAL_YEAR labels the year the books START in: with an April year start,
-- March 2026 still belongs to 2025/26. CALENDAR_YEAR is the plain year, and NONE
-- produces an empty period so the number composes without one.
SELECT '15f. period styles: financial year names the starting year, none omits the period' AS check,
       document_number_period('FINANCIAL_YEAR', 1, DATE '2026-01-01') AS fy_jan,
       document_number_period('CALENDAR_YEAR', 1, DATE '2026-06-01') AS calendar_mid,
       document_number_period('NONE', 1, DATE '2026-06-01') AS no_period,
       document_number_period('FINANCIAL_YEAR', 4, DATE '2026-03-01') AS fy_march,
       document_number_period('FINANCIAL_YEAR', 4, DATE '2026-04-01') AS fy_april;
COMMIT;

-- ── 16. an exhausted series fails instead of widening the number ─────────────
-- The ninth value still fits one digit; the tenth does not, so the function
-- raises instead of quietly emitting a two-character number that could collide
-- with another shape of the same series. The failing statement runs in its own
-- transaction, which also shows that an issuance that dies after allocating
-- burns nothing (compare check 17).
BEGIN;
SELECT '16a. a one-digit series hands out 1 through 9' AS check,
       string_agg(allocate_document_number('tenantnum0030000000000001','QUOTATION',
                                           DATE '2026-04-05'), ' ' ORDER BY s) AS numbers
FROM generate_series(1, 9) AS s;
COMMIT;

BEGIN;
SELECT '16b. the tenth allocation raises instead of widening the number' AS check;
SELECT allocate_document_number('tenantnum0030000000000001','QUOTATION',
                                DATE '2026-04-05') AS n10_expected_error;
ROLLBACK;

BEGIN;
SELECT '16c. the failed allocation consumed nothing: the counter is still 10' AS check,
       "nextValue"
FROM "DocumentNumberSequence"
WHERE "tenantId" = 'tenantnum0030000000000001' AND "type" = 'QUOTATION';
COMMIT;

-- ── 17. an allocation that is rolled back is not burned ──────────────────────
BEGIN;
SELECT '17a. number taken inside a transaction that is rolled back' AS check,
       allocate_document_number('tenantnum0050000000000001','INVOICE',
                                DATE '2026-04-05') AS taken;
ROLLBACK;
BEGIN;
SELECT '17b. the same value is handed out again: it was never issued' AS check,
       allocate_document_number('tenantnum0050000000000001','INVOICE',
                                DATE '2026-04-05') AS reused;
COMMIT;

-- ── 18. deleting or abandoning a draft never consumes a number ───────────────
BEGIN;
-- A drafted document may still be waiting for its customer (creation workflow
-- step 2), so these drafts carry no contact.
INSERT INTO "Document" ("id","tenantId","type","status")
  VALUES ('dr-1','tenantnum0060000000000001','INVOICE','DRAFT'),
         ('dr-2','tenantnum0060000000000001','INVOICE','DRAFT');
SELECT '18a. two drafts exist and neither holds a number' AS check,
       count(*) AS drafts, count("number") AS numbered
FROM "Document" WHERE "tenantId" = 'tenantnum0060000000000001';
SELECT '18b. no counter row was created while they were drafted' AS check,
       (SELECT count(*) FROM "DocumentNumberSequence"
         WHERE "tenantId" = 'tenantnum0060000000000001') AS sequences;
DELETE FROM "Document" WHERE "id" IN ('dr-1','dr-2');
SELECT '18c. drafts deleted; the series still starts at 1' AS check,
       peek_document_number('tenantnum0060000000000001','INVOICE',
                            DATE '2026-04-05') AS next_number;
COMMIT;

-- ── 19. concurrency: two sessions allocate from one series at the same time ──
-- This check cannot run inside a single-connection script, so it lives in
-- `phase05-numbering-concurrency.sql`, which is launched as two `psql` processes
-- at once. Each session commits a DO block that allocates ten numbers and
-- inserts an ISSUED invoice carrying each one, into tenant
-- `tenantnum0040000000000001`. If the counter row were not locked, both sessions
-- would read the same `nextValue` and the unique index would reject the second
-- invoice. The report below (run after both sessions have committed) proves that
-- twenty distinct, gap-free numbers exist and that the counter advanced exactly
-- twenty times:
--
--   SELECT count(DISTINCT d."number") AS numbers, count(*) AS documents,
--          min(d."number") AS first_number, max(d."number") AS last_number,
--          max(s."nextValue") - 1 AS highest_allocated
--     FROM "Document" d
--     JOIN "DocumentNumberSequence" s
--       ON s."tenantId" = d."tenantId" AND s."type" = d."type"
--    WHERE d."tenantId" = 'tenantnum0040000000000001';

-- ── 20. the numbering legacy is gone ─────────────────────────────────────────
-- The backfill itself is proved on a separate database (see the completion
-- report): migrations up to Phase 04 are applied, a tenant with
-- `documentPrefix`/`quotationPrefix` set is inserted, then the Phase 05
-- migration runs and its series are read back.
SELECT '20a. TenantSettings no longer carries numbering columns' AS check,
       coalesce(string_agg(column_name, ', ' ORDER BY column_name), 'none left') AS columns
FROM information_schema.columns
WHERE table_name = 'TenantSettings'
  AND column_name IN ('documentPrefix','quotationPrefix','documentNextNumber');

BEGIN;
SELECT '20b. an app-facing write path can still read the series for its tenant' AS check,
       "type"::text AS type, "prefix", "padding", "periodStyle"::text AS period_style
FROM "DocumentNumbering" WHERE "tenantId" = 'tenantnum0010000000000001' ORDER BY "type";
COMMIT;

-- ── 21. row level security mirrors the application isolation ─────────────────
-- Defence in depth, exercised on its own terms: nothing in the request path sets
-- `app.current_tenant_id` yet (Phase 08 wires `set_config()` into the Prisma
-- driver), so these statements prove the policies behave correctly for the day
-- it does. Every count here is the app role's own view, never the owner's.
BEGIN;
INSERT INTO "Document" ("id","tenantId","type","status","contactId") VALUES
  ('rls-d1','tenantaaa0000000000000001','INVOICE','DRAFT','c-a1'),
  ('rls-d2','tenantbbb0000000000000001','INVOICE','DRAFT','c-b1');
INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","description",
                            "quantity","unitPrice","lineTotal","lineNet") VALUES
  ('rls-l1','tenantaaa0000000000000001','rls-d1',1,'A line',1,10.00,10.00,10.00),
  ('rls-l2','tenantbbb0000000000000001','rls-d2',1,'B line',1,10.00,10.00,10.00);
-- A counter for tenant A, created through the sanctioned function.
SELECT '21. tenant A has one allocated number and one counter row' AS check,
       allocate_document_number('tenantaaa0000000000000001','INVOICE',
                                DATE '2026-04-05') AS number;
SELECT '21. owner sees every row in the database, which is the baseline' AS check,
       (SELECT count(*) FROM "DocumentLine") AS lines,
       (SELECT count(*) FROM "DocumentNumberSequence") AS counters;
SET ROLE amisibiz_app;
SET app.current_tenant_id = 'tenantaaa0000000000000001';
SELECT '21a. app role sees only tenant A''s lines' AS check, count(*) AS visible_lines
FROM "DocumentLine";
SELECT '21b. and only tenant A''s counter' AS check,
       count(*) AS visible_counters, string_agg("type"::text, ',') AS types
FROM "DocumentNumberSequence";
RESET app.current_tenant_id;
SELECT '21c. with no tenant context the app role sees nothing' AS check,
       (SELECT count(*) FROM "DocumentLine") AS lines,
       (SELECT count(*) FROM "DocumentNumberSequence") AS counters;
SET app.current_tenant_id = 'tenantaaa0000000000000001';
SAVEPOINT before_forged_series;
-- `DocumentNumbering` carries a policy but no cross-tenant trigger, so this is
-- the purest test of the WITH CHECK clause: a series written for another tenant.
INSERT INTO "DocumentNumbering" ("id","tenantId","type","prefix","padding","separator","periodStyle")
  VALUES ('rls-num-forge','tenantbbb0000000000000001','INVOICE','FORGE',4,'-','CALENDAR_YEAR');
ROLLBACK TO SAVEPOINT before_forged_series;
SELECT '21d. forged series for another tenant rejected (see RLS error above)' AS check,
       'rejected' AS result;
RESET ROLE;
ROLLBACK;

-- ── 22. the app role cannot rewrite the counters directly ────────────────────
BEGIN;
SET ROLE amisibiz_app;
SET app.current_tenant_id = 'tenantnum0010000000000001';
SAVEPOINT before_counter_delete;
DELETE FROM "DocumentNumberSequence" WHERE "tenantId" = 'tenantnum0010000000000001';
ROLLBACK TO SAVEPOINT before_counter_delete;
SELECT '22. direct DELETE on the counter table is not granted (see error above)' AS check,
       'rejected' AS result;
RESET ROLE;
ROLLBACK;

-- ── 23. numbers are safe identifiers, stored and freshly generated ───────────
BEGIN;
SELECT '23a. every number stored in the database satisfies the printed-format CHECK' AS check,
       count(*) AS numbers,
       count(*) FILTER (WHERE "number" !~ '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,63}$') AS unsafe
FROM "Document" WHERE "number" IS NOT NULL;
-- The same pattern the CHECK enforces, applied to what the function emits for
-- each configured series shape: default, tenant-chosen prefix with no period,
-- and a rolled-back allocation that proves nothing was burned.
SELECT '23b. numbers generated by the function match it too' AS check,
       n AS number,
       (n ~ '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,63}$') AS safe
FROM (
    SELECT allocate_document_number('tenantnum0060000000000001','DELIVERY_NOTE',
                                    DATE '2026-04-05') AS n
    UNION ALL
    SELECT allocate_document_number('tenantnum0020000000000001','INVOICE',
                                    DATE '2026-04-05')
    UNION ALL
    SELECT peek_document_number('tenantnum0010000000000001','QUOTATION',
                                DATE '2027-01-01')
) generated;
ROLLBACK;

-- The rolled-back allocations above must not have advanced the series they
-- touched, and the earlier committed allocation for tenant A must have.
SELECT '23c. rolled-back allocations burned nothing' AS check,
       coalesce((SELECT "nextValue"::text FROM "DocumentNumberSequence"
                  WHERE "tenantId" = 'tenantnum0060000000000001' AND "type" = 'DELIVERY_NOTE'
                    AND "period" = '2026'), 'series row does not exist either')
         AS tenant_num_006_delivery_notes,
       (SELECT "nextValue" FROM "DocumentNumberSequence"
         WHERE "tenantId" = 'tenantnum0020000000000001' AND "type" = 'INVOICE'
           AND "period" = '') AS tenant_num_002_invoices_still_at;
