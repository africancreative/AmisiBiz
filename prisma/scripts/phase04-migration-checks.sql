-- Phase 04 migration behaviour checks (run against the scratch database only).
-- Every statement prints a name and the observed result so the run is auditable.
\pset footer off
\set ON_ERROR_STOP off

-- Prisma writes @updatedAt from the application, so the columns have no database
-- default. This scratch-only shim lets the raw SQL below focus on the
-- constraints; it changes nothing about the migration itself.
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

-- ── setup: two tenants, one owner role and one app role ──────────────────────
BEGIN;
INSERT INTO "Tenant" ("id","name","slug","currency") VALUES
  ('tenantaaa0000000000000001','Tenant A','tenant-a','KES'),
  ('tenantbbb0000000000000001','Tenant B','tenant-b','KES')
ON CONFLICT ("id") DO NOTHING;
COMMIT;

-- ── 1. money columns are exact decimals, not float ──────────────────────────
BEGIN;
INSERT INTO "TaxCategory" ("id","tenantId","name") VALUES ('cat-a','tenantaaa0000000000000001','VAT');
INSERT INTO "TaxRate" ("id","tenantId","categoryId","name","rate")
  VALUES ('rate-a','tenantaaa0000000000000001','cat-a','VAT 16%', 0.16);
SELECT '1. rate stored exactly as a fraction' AS check, "rate"::text FROM "TaxRate" WHERE "id"='rate-a';
ROLLBACK;

-- ── 2. tax rate range is enforced ───────────────────────────────────────────
BEGIN;
SELECT '2. rate > 1 rejected' AS check;
INSERT INTO "TaxCategory" ("id","tenantId","name") VALUES ('cat-x','tenantaaa0000000000000001','X');
INSERT INTO "TaxRate" ("id","tenantId","categoryId","name","rate") VALUES ('rate-x','tenantaaa0000000000000001','cat-x','bad', 16);
ROLLBACK;

-- ── 3. SKU uniqueness is tenant-scoped, and NULL SKUs do not collide ────────
BEGIN;
INSERT INTO "Item" ("id","tenantId","name","sku","unitPrice") VALUES
  ('i-a1','tenantaaa0000000000000001','A widget','SKU-1',100),
  ('i-b1','tenantbbb0000000000000001','B widget','SKU-1',200),
  ('i-a2','tenantaaa0000000000000001','A no-sku',NULL,10),
  ('i-a3','tenantaaa0000000000000001','A no-sku 2',NULL,10);
SELECT '3. same SKU in two tenants + two blank SKUs accepted' AS check, count(*) FROM "Item";
ROLLBACK;

-- ── 4. duplicate SKU inside one tenant is rejected ──────────────────────────
BEGIN;
SELECT '4. duplicate SKU in one tenant rejected' AS check;
INSERT INTO "Item" ("id","tenantId","name","sku","unitPrice") VALUES
  ('i-a1','tenantaaa0000000000000001','A','SKU-9',1),
  ('i-a4','tenantaaa0000000000000001','B','SKU-9',1);
ROLLBACK;

-- ── 5. blank SKU string is rejected (must be NULL) ──────────────────────────
BEGIN;
SELECT '5. blank-string SKU rejected' AS check;
INSERT INTO "Item" ("id","tenantId","name","sku","unitPrice") VALUES ('i-a5','tenantaaa0000000000000001','C','',1);
ROLLBACK;

-- ── 6. negative money is rejected ───────────────────────────────────────────
BEGIN;
SELECT '6. negative unit price rejected' AS check;
INSERT INTO "Item" ("id","tenantId","name","unitPrice") VALUES ('i-a6','tenantaaa0000000000000001','D',-1);
ROLLBACK;

-- ── 7. an item cannot borrow another tenant's tax rate ───────────────────────
BEGIN;
SELECT '7. cross-tenant taxRateId rejected' AS check;
INSERT INTO "TaxCategory" ("id","tenantId","name") VALUES ('cat-b','tenantbbb0000000000000001','VAT');
INSERT INTO "TaxRate" ("id","tenantId","categoryId","name","rate") VALUES ('rate-b','tenantbbb0000000000000001','cat-b','VAT 16%',0.16);
INSERT INTO "Item" ("id","tenantId","name","unitPrice","taxRateId") VALUES ('i-a7','tenantaaa0000000000000001','E',1,'rate-b');
ROLLBACK;

-- ── 8. contact identity + archive consistency ───────────────────────────────
BEGIN;
SELECT '8a. business contact without company name rejected' AS check;
INSERT INTO "Contact" ("id","tenantId","type") VALUES ('c-1','tenantaaa0000000000000001','BUSINESS');
ROLLBACK;

BEGIN;
SELECT '8b. archived contact without archivedAt rejected' AS check;
INSERT INTO "Contact" ("id","tenantId","type","firstName","status") VALUES ('c-2','tenantaaa0000000000000001','INDIVIDUAL','Ann','ARCHIVED');
ROLLBACK;

BEGIN;
SELECT '8c. one default address per contact+type' AS check;
INSERT INTO "Contact" ("id","tenantId","type","firstName") VALUES ('c-3','tenantaaa0000000000000001','INDIVIDUAL','Ann');
INSERT INTO "ContactAddress" ("id","contactId","type","line1","isDefault") VALUES ('ad-1','c-3','POSTAL','Box 1',true);
INSERT INTO "ContactAddress" ("id","contactId","type","line1","isDefault") VALUES ('ad-2','c-3','POSTAL','Box 2',true);
ROLLBACK;

-- ── 9. a customer price cannot move another tenant's item ───────────────────
BEGIN;
SELECT '9. cross-tenant ContactItem rejected' AS check;
INSERT INTO "Contact" ("id","tenantId","type","firstName") VALUES ('c-4','tenantaaa0000000000000001','INDIVIDUAL','Ann');
INSERT INTO "Item" ("id","tenantId","name","unitPrice") VALUES ('i-b2','tenantbbb0000000000000001','F',50);
INSERT INTO "ContactItem" ("id","tenantId","contactId","itemId","agreedPrice") VALUES ('ci-1','tenantaaa0000000000000001','c-4','i-b2',40);
ROLLBACK;

-- ── 10. agreed price does not change the default price ──────────────────────
BEGIN;
INSERT INTO "Contact" ("id","tenantId","type","firstName") VALUES ('c-5','tenantaaa0000000000000001','INDIVIDUAL','Ann');
INSERT INTO "Item" ("id","tenantId","name","unitPrice") VALUES ('i-a8','tenantaaa0000000000000001','G',100);
INSERT INTO "ContactItem" ("id","tenantId","contactId","itemId","agreedPrice") VALUES ('ci-2','tenantaaa0000000000000001','c-5','i-a8',80);
SELECT '10. default price untouched by a customer price' AS check,
       (SELECT "unitPrice"::text FROM "Item" WHERE "id"='i-a8') AS default_price,
       (SELECT "agreedPrice"::text FROM "ContactItem" WHERE "id"='ci-2') AS agreed_price;
ROLLBACK;

-- ── 11. branding colour + logo URL validation ───────────────────────────────
BEGIN;
SELECT '11a. CSS injection in a colour rejected' AS check;
INSERT INTO "TenantBranding" ("id","tenantId","primaryColor") VALUES ('br-1','tenantaaa0000000000000001','red; } body { display:none');
ROLLBACK;

BEGIN;
SELECT '11b. javascript: logo URL rejected' AS check;
INSERT INTO "TenantBranding" ("id","tenantId","logoUrl") VALUES ('br-2','tenantaaa0000000000000001','javascript:alert(1)');
ROLLBACK;

BEGIN;
INSERT INTO "TenantBranding" ("id","tenantId","logoUrl","primaryColor")
  VALUES ('br-3','tenantaaa0000000000000001','/uploads/tenants/tenantaaa0000000000000001/logo/deadbeefdeadbeefdeadbeefdeadbeef.png','#1d4ed8');
SELECT '11c. controlled logo URL accepted' AS check, "logoUrl" FROM "TenantBranding" WHERE "id"='br-3';
ROLLBACK;

-- ── 12. issued documents survive contact archiving (no cascade destruction) ─
-- Phase 05's issuance constraints require the snapshot fields, a due date on
-- an issued invoice, and an issuing actor, so the fixture carries them.
BEGIN;
INSERT INTO "User" ("id","email","name","platformRole","status")
  VALUES ('actor-1','actor@example.invalid','Issuer One','USER','ACTIVE')
  ON CONFLICT ("id") DO NOTHING;
INSERT INTO "Contact" ("id","tenantId","type","firstName") VALUES ('c-6','tenantaaa0000000000000001','INDIVIDUAL','Ann');
INSERT INTO "Document" ("id","tenantId","contactId","type","number","status","subtotal","totalDiscount","taxableBase","taxTotal","total","currency","snapshot","snapshotAt","issuedAt","issuedById","dueDate")
  VALUES ('d-1','tenantaaa0000000000000001','c-6','INVOICE','INV-0001','ISSUED',1000,0,1000,0,1000,'KES','{}',now(),now(),'actor-1', now() + interval '30 days');
UPDATE "Contact" SET "status"='ARCHIVED',"archivedAt"=now() WHERE "id"='c-6';
SELECT '12. document keeps its contact after archive' AS check, count(*) AS documents FROM "Document" WHERE "contactId"='c-6';
ROLLBACK;

-- ── 13. row level security isolates tenants for the app role ────────────────
BEGIN;
INSERT INTO "Contact" ("id","tenantId","type","firstName") VALUES
  ('rls-a','tenantaaa0000000000000001','INDIVIDUAL','Ava'),
  ('rls-b','tenantbbb0000000000000001','INDIVIDUAL','Bea');
SET ROLE amisibiz_app;
SET app.current_tenant_id = 'tenantaaa0000000000000001';
SELECT '13a. app role sees only its tenant' AS check, count(*) AS visible FROM "Contact";
RESET app.current_tenant_id;
SELECT '13b. with no tenant context the app role sees nothing' AS check, count(*) AS visible FROM "Contact";
RESET ROLE;
ROLLBACK;

-- ── 14. RLS WITH CHECK blocks a forged tenantId write ───────────────────────
-- The rejected INSERT is the expected result, so it runs inside a savepoint: the
-- statement aborts the transaction, the savepoint rewinds it, and the check can
-- still report cleanly instead of cascading "aborted transaction" errors.
BEGIN;
INSERT INTO "Contact" ("id","tenantId","type","firstName") VALUES ('rls-c','tenantaaa0000000000000001','INDIVIDUAL','Cia');
SET ROLE amisibiz_app;
SET app.current_tenant_id = 'tenantaaa0000000000000001';
SAVEPOINT before_forged_write;
INSERT INTO "Contact" ("id","tenantId","type","firstName") VALUES ('rls-d','tenantbbb0000000000000001','INDIVIDUAL','Dee');
ROLLBACK TO SAVEPOINT before_forged_write;
RESET app.current_tenant_id;
SELECT '14. write tagged with another tenant rejected' AS check, 'see the RLS error above' AS result;
RESET ROLE;
ROLLBACK;
