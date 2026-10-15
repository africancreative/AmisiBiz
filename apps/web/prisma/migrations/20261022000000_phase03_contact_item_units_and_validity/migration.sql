-- Phase 03 brief — customer-specific catalogue: customer unit and validity window.
--
-- The customer-specific catalogue already stores a per-customer code, name,
-- price and discount. This adds the two remaining terms the brief names: a
-- customer-specific unit of measure and the dates the agreement is effective.
--
-- Nothing here rewrites an existing agreement: the new columns are nullable, so
-- every row keeps its current meaning (no custom unit, no expiry) and a document
-- line written before this migration is never re-derived from the catalogue.

ALTER TABLE "ContactItem"
    ADD COLUMN "customUnitOfMeasure" TEXT,
    ADD COLUMN "validFrom" TIMESTAMP(3),
    ADD COLUMN "validUntil" TIMESTAMP(3);

-- A validity window must not run backwards. NULL means "open", so a one-sided
-- window (from-only or until-only) is valid and an absent window never expires.
ALTER TABLE "ContactItem"
    ADD CONSTRAINT "ContactItem_validity_window_check"
    CHECK (
        "validFrom" IS NULL
        OR "validUntil" IS NULL
        OR "validFrom" <= "validUntil"
    );
