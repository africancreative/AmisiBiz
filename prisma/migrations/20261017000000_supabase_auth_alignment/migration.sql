-- Phase 04.5a — Supabase Auth alignment.
--
-- Identity authority moves to Supabase Auth (GoTrue). The tables that backed
-- the retired Auth.js credentials stack are dropped, and the locally stored
-- bcrypt password column is removed — credentials now live exclusively in
-- Supabase Auth. App profile rows in "User" mirror GoTrue users: `id` equals
-- the Supabase Auth user UUID (assigned at registration / reconciled by the
-- seed with ON UPDATE CASCADE).
--
-- Applied AFTER 20261016000000 (which enabled RLS on these auth tables);
-- dropping a table removes its policies and RLS state automatically.

-- Single-use account tokens (email verification / password reset) are
-- replaced by Supabase Auth email links.
DROP TABLE IF EXISTS "AccountToken";

-- Auth.js session, account-link and verification storage.
DROP TABLE IF EXISTS "Account";
DROP TABLE IF EXISTS "Session";
DROP TABLE IF EXISTS "VerificationToken";

-- Credentials are held by Supabase Auth; no local password hash is kept.
ALTER TABLE "User" DROP COLUMN IF EXISTS "password";

-- Enum only referenced by the dropped "AccountToken" table.
DROP TYPE IF EXISTS "AccountTokenPurpose";
