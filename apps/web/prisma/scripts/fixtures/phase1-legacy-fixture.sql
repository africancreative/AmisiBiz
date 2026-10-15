-- Phase 1 migration verification fixture.
-- Applied AFTER the 7 legacy migrations and BEFORE the 3 Phase 1 migrations.
-- Every conversion path is represented:
--   * all five legacy TenantRole values and all three legacy PlatformRole values;
--   * every one of the seven join-mapped entities (tenant, taxcategory, taxrate,
--     contact, item, document, documentline) with at least one reference to it;
--   * a reversed payment (append-only trigger window) and an issued invoice
--     with snapshot + status events;
--   * both Tenant status-attribution columns (activatedById, suspendedById);
--   * one other-app table (`other_app_data`) that the pre-Phase-1 blanket
--     grants would have covered — created separately in the harness, not here.

-- ── Users ────────────────────────────────────────────────────────────────────
INSERT INTO "User" ("id","name","email","emailVerified","image","platformRole","status","sessionVersion","createdAt","updatedAt") VALUES
  ('a1a1a1a1-1111-4111-8111-111111111111','Owner A','owner.a@example.com',now(),NULL,'PLATFORM_ADMIN','ACTIVE',0,'2026-01-01 08:00:00','2026-01-01 08:00:00'),
  ('b2b2b2b2-2222-4222-8222-222222222222','Owner B','owner.b@example.com',now(),NULL,'USER','ACTIVE',0,'2026-01-02 08:00:00','2026-01-02 08:00:00'),
  ('c3c3c3c3-3333-4333-8333-333333333333','Member C','member.c@example.com',now(),NULL,'USER','ACTIVE',0,'2026-01-03 08:00:00','2026-01-03 08:00:00'),
  ('d4d4d4d4-4444-4444-8444-444444444444','Support D','support.d@example.com',now(),NULL,'PLATFORM_SUPPORT','ACTIVE',0,'2026-01-04 08:00:00','2026-01-04 08:00:00'),
  ('e5e5e5e5-5555-4555-8555-555555555555','Invitee E','invitee@example.com',NULL,NULL,'USER','INVITED',0,'2026-01-05 08:00:00','2026-01-05 08:00:00'),
  ('e6e6e6e6-6666-4666-8666-666666666666','Owner E','owner.e@example.com',now(),NULL,'USER','ACTIVE',0,'2026-01-06 08:00:00','2026-01-06 08:00:00');

-- ── Tenants ──────────────────────────────────────────────────────────────────
INSERT INTO "Tenant" ("id","name","slug","logoUrl","status","country","currency","timezone","locale","planId","activatedAt","activatedById","suspendedAt","suspendedById","suspensionReason","createdAt","updatedAt") VALUES
  ('tenant_aaa','Alpha Ltd','alpha',NULL,'ACTIVE','KE','KES','Africa/Nairobi','en','starter','2026-01-01 09:00:00','a1a1a1a1-1111-4111-8111-111111111111',NULL,NULL,NULL,'2026-01-01 08:30:00','2026-01-01 09:00:00'),
  ('tenant_bbb','Beta Ltd','beta',NULL,'SUSPENDED','KE','KES','Africa/Nairobi','en','starter',NULL,NULL,'2026-02-01 10:00:00','a1a1a1a1-1111-4111-8111-111111111111','Non-payment','2026-01-02 08:30:00','2026-02-01 10:00:00');

-- ── Settings / branding / domains ────────────────────────────────────────────
INSERT INTO "TenantSettings" ("id","tenantId","createdAt","updatedAt") VALUES
  ('settings_a','tenant_aaa','2026-01-01 08:31:00','2026-01-01 08:31:00'),
  ('settings_b','tenant_bbb','2026-01-02 08:31:00','2026-01-02 08:31:00');

INSERT INTO "TenantBranding" ("id","tenantId","displayName","primaryColor","accentColor","primaryForeground","secondaryColor","logoUrl","registeredName","contactEmail","contactPhone","postalAddress","physicalAddress","website","taxPin","currency","defaultFooter","paymentInstructions","documentLayout","createdAt","updatedAt") VALUES
  ('branding_a','tenant_aaa','Alpha Ltd','#1d4ed8','#f59e0b','#f8fafc','#1e3a5f',NULL,'Alpha Limited','info@alpha.example',NULL,NULL,NULL,NULL,NULL,'KES',NULL,NULL,'standard','2026-01-01 08:32:00','2026-01-01 08:32:00'),
  ('branding_b','tenant_bbb','Beta Ltd','#1d4ed8','#f59e0b','#f8fafc','#1e3a5f',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'KES',NULL,NULL,'standard','2026-01-02 08:32:00','2026-01-02 08:32:00');

INSERT INTO "TenantDomain" ("id","tenantId","hostname","isPrimary","verifiedAt","createdAt") VALUES
  ('domain_a','tenant_aaa','alpha.example.com',true,'2026-01-01 09:30:00','2026-01-01 08:33:00'),
  ('domain_b','tenant_bbb','beta.example.com',false,NULL,'2026-01-02 08:33:00');

-- ── Memberships: all five legacy roles ───────────────────────────────────────
INSERT INTO "TenantMember" ("id","tenantId","userId","role","isDefault","joinedAt","updatedAt") VALUES
  ('member_1','tenant_aaa','a1a1a1a1-1111-4111-8111-111111111111','BUSINESS_OWNER',true,'2026-01-01 08:35:00','2026-01-01 08:35:00'),
  ('member_2','tenant_aaa','b2b2b2b2-2222-4222-8222-222222222222','SALES_STAFF',false,'2026-01-03 08:35:00','2026-01-03 08:35:00'),
  ('member_3','tenant_aaa','c3c3c3c3-3333-4333-8333-333333333333','VIEWER',false,'2026-01-04 08:35:00','2026-01-04 08:35:00'),
  ('member_4','tenant_bbb','b2b2b2b2-2222-4222-8222-222222222222','BUSINESS_ADMIN',true,'2026-01-02 08:35:00','2026-01-02 08:35:00'),
  ('member_5','tenant_bbb','c3c3c3c3-3333-4333-8333-333333333333','DOCUMENT_MANAGER',false,'2026-01-05 08:35:00','2026-01-05 08:35:00'),
  -- u6: a plain owner of tenant A — no platform role, no seat in B. The RLS
  -- battery needs this subject because u1 is a platform administrator by
  -- design, and platform authority is re-derived from the database, so u1 can
  -- legitimately reach every tenant.
  ('member_6','tenant_aaa','e6e6e6e6-6666-4666-8666-666666666666','BUSINESS_OWNER',true,'2026-01-06 08:35:00','2026-01-06 08:35:00');

-- ── Tax data ─────────────────────────────────────────────────────────────────
INSERT INTO "TaxCategory" ("id","tenantId","name","description","isDefault","createdAt","updatedAt") VALUES
  ('taxcat_a','tenant_aaa','VAT','Standard VAT',true,'2026-01-01 08:40:00','2026-01-01 08:40:00'),
  ('taxcat_b','tenant_bbb','VAT','Standard VAT',true,'2026-01-02 08:40:00','2026-01-02 08:40:00');

INSERT INTO "TaxRate" ("id","tenantId","categoryId","name","rate","effectiveFrom","effectiveTo","isActive","createdAt","updatedAt") VALUES
  ('taxrate_a','tenant_aaa','taxcat_a','VAT 16%',0.1600,'2026-01-01 00:00:00',NULL,true,'2026-01-01 08:41:00','2026-01-01 08:41:00'),
  ('taxrate_b','tenant_bbb','taxcat_b','VAT 16%',0.1600,'2026-01-01 00:00:00',NULL,true,'2026-01-02 08:41:00','2026-01-02 08:41:00');

-- ── Contacts & addresses ─────────────────────────────────────────────────────
INSERT INTO "Contact" ("id","tenantId","type","status","firstName","lastName","companyName","email","phone","mobile","taxPin","notes","createdAt","updatedAt","archivedAt") VALUES
  ('contact_a','tenant_aaa','BUSINESS','ACTIVE',NULL,NULL,'Acme Traders Ltd','sales@acme.example','+254700000001',NULL,'P051234567X',NULL,'2026-01-10 09:00:00','2026-01-10 09:00:00',NULL),
  ('contact_b','tenant_bbb','INDIVIDUAL','ACTIVE','Jane','Doe',NULL,'jane@beta.example',NULL,NULL,NULL,NULL,'2026-01-11 09:00:00','2026-01-11 09:00:00',NULL);

INSERT INTO "ContactAddress" ("id","contactId","type","line1","line2","city","state","postalCode","country","isDefault","createdAt","updatedAt") VALUES
  ('addr_a1','contact_a','POSTAL','12 Industrial Area','P.O. Box 100','Nairobi','Nairobi','00100','KE',true,'2026-01-10 09:01:00','2026-01-10 09:01:00'),
  ('addr_b1','contact_b','POSTAL','5 Riverside Drive',NULL,'Nairobi',NULL,NULL,'KE',true,'2026-01-11 09:01:00','2026-01-11 09:01:00');

-- ── Items ────────────────────────────────────────────────────────────────────
INSERT INTO "Item" ("id","tenantId","type","status","name","sku","description","unitOfMeasure","unitPrice","currency","taxRateId","notes","createdAt","updatedAt") VALUES
  ('item_a1','tenant_aaa','PRODUCT','ACTIVE','Widget','W-1','A widget','each',500.0000,'KES','taxrate_a',NULL,'2026-01-12 09:00:00','2026-01-12 09:00:00'),
  ('item_b1','tenant_bbb','SERVICE','ACTIVE','Consulting','S-1',NULL,'hour',2500.0000,'KES','taxrate_b',NULL,'2026-01-12 10:00:00','2026-01-12 10:00:00');

INSERT INTO "ContactItem" ("id","tenantId","contactId","itemId","agreedPrice","discountPercent","isAvailable","customCode","customName","createdAt","updatedAt") VALUES
  ('citem_a1','tenant_aaa','contact_a','item_a1',480.0000,0,true,NULL,NULL,'2026-01-12 11:00:00','2026-01-12 11:00:00'),
  ('citem_b1','tenant_bbb','contact_b','item_b1',2500.0000,0,true,NULL,NULL,'2026-01-12 11:30:00','2026-01-12 11:30:00');

-- ── Documents ────────────────────────────────────────────────────────────────
-- All three start as DRAFT (lines can only be added while draft — the
-- immutability trigger enforces exactly that, as this fixture discovered);
-- doc_inv1 and doc_dn1 are then issued by UPDATE, which is also how the
-- application issues them.
INSERT INTO "Document" ("id","tenantId","contactId","type","number","status","total","currency","issuedAt","createdAt","updatedAt","customerNote","deliveryDate","deliveryNote","dueDate","expiryDate","idempotencyKey","issueDate","issuedById","replacementOfId","roundingPolicy","snapshot","snapshotAt","sourceDocumentId","subtotal","taxBreakdown","taxTotal","taxableBase","terms","totalDiscount","voidReason","voidedAt","voidedById") VALUES
  ('doc_q1','tenant_aaa','contact_a','QUOTATION',NULL,'DRAFT',1160.0000,'KES',NULL,'2026-01-15 10:00:00','2026-01-15 10:00:00',NULL,NULL,NULL,NULL,'2026-02-14 23:59:59',NULL,'2026-01-15',NULL,NULL,'half-up-per-line-v1',NULL,NULL,NULL,1000.0000,NULL,160.0000,1000.0000,NULL,0.0000,NULL,NULL,NULL),
  ('doc_inv1','tenant_aaa','contact_a','INVOICE',NULL,'DRAFT',1160.0000,'KES',NULL,'2026-01-16 10:00:00','2026-01-16 10:00:00','Thank you',NULL,NULL,'2026-02-15 23:59:59',NULL,NULL,'2026-01-16',NULL,NULL,'half-up-per-line-v1',NULL,NULL,'doc_q1',1000.0000,'[{"name":"VAT 16%","rate":"0.1600","taxable":"1000.0000","amount":"160.0000"}]',160.0000,1000.0000,'Payment due within 30 days.',0.0000,NULL,NULL,NULL),
  ('doc_dn1','tenant_aaa','contact_a','DELIVERY_NOTE',NULL,'DRAFT',0.0000,'KES',NULL,'2026-01-17 10:00:00','2026-01-17 10:00:00',NULL,'2026-01-17 00:00:00','Delivered in full.',NULL,NULL,NULL,'2026-01-17',NULL,NULL,'half-up-per-line-v1',NULL,NULL,'doc_q1',0.0000,NULL,0.0000,0.0000,NULL,0.0000,NULL,NULL,NULL);

INSERT INTO "DocumentLine" ("id","tenantId","documentId","position","itemId","sourceLineId","description","itemCode","unitOfMeasure","quantity","unitPrice","discountType","discountPercent","discountAmount","lineTotal","lineDiscount","lineNet","lineTax","taxRateId","taxName","taxRate","deliveredQuantity","createdAt","updatedAt") VALUES
  ('line_q1_1','tenant_aaa','doc_q1',1,'item_a1',NULL,'Widget','W-1','each',2.0000,500.0000,NULL,0.0000,0.0000,1000.0000,0.0000,1000.0000,160.0000,'taxrate_a','VAT 16%',0.1600,0.0000,'2026-01-15 10:00:01','2026-01-15 10:00:01'),
  ('line_inv1_1','tenant_aaa','doc_inv1',1,'item_a1','line_q1_1','Widget','W-1','each',2.0000,500.0000,NULL,0.0000,0.0000,1000.0000,0.0000,1000.0000,160.0000,'taxrate_a','VAT 16%',0.1600,2.0000,'2026-01-16 10:00:01','2026-01-16 10:00:01'),
  ('line_dn1_1','tenant_aaa','doc_dn1',1,'item_a1','line_inv1_1','Widget','W-1','each',2.0000,500.0000,NULL,0.0000,0.0000,1000.0000,0.0000,1000.0000,160.0000,'taxrate_a','VAT 16%',0.1600,2.0000,'2026-01-17 10:00:01','2026-01-17 10:00:01');

-- ── Issue the invoice and the delivery note ──────────────────────────────────
-- The issuance transition the application performs: number + snapshot + issuer
-- appear together, lines are already in place. The immutability trigger only
-- compares fields when OLD.status <> 'DRAFT', so this transition passes.
UPDATE "Document" SET
    "status" = 'ISSUED', "number" = 'INV-2026-0001', "issuedAt" = '2026-01-16 10:00:00',
    "issuedById" = 'a1a1a1a1-1111-4111-8111-111111111111',
    "snapshot" = '{"lines":[{"position":1,"description":"Widget","quantity":"2.0000","unitPrice":"500.0000"}],"currency":"KES"}',
    "snapshotAt" = '2026-01-16 10:00:01', "updatedAt" = '2026-01-16 10:00:00'
WHERE "id" = 'doc_inv1';

UPDATE "Document" SET
    "status" = 'ISSUED', "number" = 'DN-2026-0001', "issuedAt" = '2026-01-17 10:00:00',
    "issuedById" = 'a1a1a1a1-1111-4111-8111-111111111111',
    "snapshot" = '{"lines":[],"currency":"KES"}',
    "snapshotAt" = '2026-01-17 10:00:01', "updatedAt" = '2026-01-17 10:00:00'
WHERE "id" = 'doc_dn1';

-- ── Payments: one live, one reversed (append-only trigger window) ────────────
INSERT INTO "DocumentPayment" ("id","tenantId","documentId","amount","occurredOn","method","reference","note","reversedAt","reversedBy","createdAt","updatedAt") VALUES
  ('pay_1','tenant_aaa','doc_inv1',500.0000,'2026-01-20 09:00:00','BANK_TRANSFER','TRX-001',NULL,NULL,NULL,'2026-01-20 09:05:00','2026-01-20 09:05:00'),
  ('pay_2','tenant_aaa','doc_inv1',660.0000,'2026-01-25 09:00:00','MOBILE_MONEY','MPESA-002','Wrong account','2026-01-26 09:00:00','a1a1a1a1-1111-4111-8111-111111111111','2026-01-25 09:05:00','2026-01-26 09:00:00');

-- ── Status events (append-only) ──────────────────────────────────────────────
INSERT INTO "DocumentStatusEvent" ("id","tenantId","documentId","fromStatus","toStatus","reason","actorId","createdAt") VALUES
  ('evt_1','tenant_aaa','doc_q1',NULL,'DRAFT',NULL,'a1a1a1a1-1111-4111-8111-111111111111','2026-01-15 10:00:00'),
  ('evt_2','tenant_aaa','doc_inv1','DRAFT','ISSUED',NULL,'a1a1a1a1-1111-4111-8111-111111111111','2026-01-16 10:00:00'),
  ('evt_3','tenant_aaa','doc_dn1','DRAFT','ISSUED',NULL,'a1a1a1a1-1111-4111-8111-111111111111','2026-01-17 10:00:00');

-- ── Numbering state ──────────────────────────────────────────────────────────
INSERT INTO "DocumentNumbering" ("id","tenantId","type","prefix","padding","separator","periodStyle","fiscalStartMonth","createdAt","updatedAt") VALUES
  ('num_a_inv','tenant_aaa','INVOICE','INV',4,'-','CALENDAR_YEAR',1,'2026-01-01 08:50:00','2026-01-01 08:50:00');

INSERT INTO "DocumentNumberSequence" ("id","tenantId","type","period","nextValue","createdAt","updatedAt") VALUES
  ('nseq_a_inv','tenant_aaa','INVOICE','2026',2,'2026-01-16 10:00:00','2026-01-16 10:00:00');

-- ── Invitation ───────────────────────────────────────────────────────────────
INSERT INTO "Invitation" ("id","tenantId","email","role","status","invitedBy","expiresAt","acceptedAt","createdAt","updatedAt","tokenHash") VALUES
  ('invite_1','tenant_aaa','invitee@example.com','VIEWER','PENDING','a1a1a1a1-1111-4111-8111-111111111111','2026-02-15 10:00:00',NULL,'2026-01-18 10:00:00','2026-01-18 10:00:00','tokenhash_invite_1');

-- ── Audit rows ───────────────────────────────────────────────────────────────
INSERT INTO "AuditLog" ("id","tenantId","userId","action","resource","resourceId","metadata","ipAddress","userAgent","createdAt") VALUES
  ('audit_1','tenant_aaa','a1a1a1a1-1111-4111-8111-111111111111','tenant.created','Tenant','tenant_aaa',NULL,'127.0.0.1','fixture','2026-01-01 08:30:00'),
  ('audit_2',NULL,'a1a1a1a1-1111-4111-8111-111111111111','platform.seed','User',NULL,NULL,NULL,NULL,'2026-01-01 08:00:00'),
  ('audit_3','tenant_aaa','c3c3c3c3-3333-4333-8333-333333333333','document.downloaded','Document','doc_inv1','{"format":"pdf"}','127.0.0.2','fixture','2026-01-19 12:00:00');
