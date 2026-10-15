-- Phase 05 · customer-portal document access
--
-- A portal user is an ordinary `User` whose `TenantMember.role` is
-- CUSTOMER_PORTAL_USER. This migration adds the one link that gives that user a
-- customer identity: `Contact.portalUserId`. The portal read path resolves this
-- row in the authorized tenant and then refuses any document whose `contactId`
-- is not this contact, so a portal user can only ever see their own documents.
--
-- The column is nullable (most contacts have no portal access) and the unique
-- index is on `(tenantId, portalUserId)`: one portal user maps to at most one
-- contact PER TENANT. PostgreSQL treats NULLs as distinct in a unique index, so
-- the many contacts without portal access do not collide. Revoking access is
-- setting the column back to NULL — no document moves, because visibility is
-- computed from this link, never copied onto a document.

ALTER TABLE "Contact" ADD COLUMN "portalUserId" UUID;

ALTER TABLE "Contact" ADD CONSTRAINT "Contact_portalUserId_fkey"
  FOREIGN KEY ("portalUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Contact_tenantId_portalUserId_key"
  ON "Contact"("tenantId", "portalUserId");
