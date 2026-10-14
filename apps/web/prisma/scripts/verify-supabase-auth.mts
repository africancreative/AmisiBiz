/**
 * Phase 04.5a verification probe — Supabase Auth semantics.
 *
 * Proves, against the real project, the exact behaviours the auth swap relies
 * on. Creates a disposable user, exercises sign-in → app_metadata claim →
 * refresh rotation → ban-based session kill → unban, and deletes the user
 * again. No email is sent (email_confirm: true).
 *
 * Run (values come from the git-ignored .env):
 *   export SUPABASE_URL=$(grep -m1 '^NEXT_PUBLIC_SUPABASE_URL=' .env | cut -d= -f2- | tr -d '"')
 *   export SUPABASE_PUBLISHABLE_KEY=$(grep -m1 '^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=' .env | cut -d= -f2- | tr -d '"')
 *   export SUPABASE_SECRET_KEY=$(grep -m1 '^SUPABASE_SECRET_KEY=' .env | cut -d= -f2- | tr -d '"')
 *   pnpm tsx prisma/scripts/verify-supabase-auth.mts
 */
import { createClient } from "@supabase/supabase-js";
import { randomBytes } from "crypto";

const url = process.env.SUPABASE_URL;
const publishable = process.env.SUPABASE_PUBLISHABLE_KEY;
const secret = process.env.SUPABASE_SECRET_KEY;

if (!url || !publishable || !secret) {
  console.error(
    "[probe] Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY env.",
  );
  process.exit(2);
}

function decodeClaim(accessToken: string): Record<string, unknown> | null {
  try {
    const payload = accessToken.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

const admin = createClient(url, secret, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const anon = createClient(url, publishable, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const email = `phase045-probe-${randomBytes(4).toString("hex")}@example.com`;
const password = randomBytes(18).toString("base64url");

let createdId = "";
let failed = false;

try {
  const { data: created, error: createErr } = await admin.auth.admin.createUser(
    {
      email,
      password,
      email_confirm: true,
      app_metadata: { probe: true },
    },
  );
  if (createErr) throw createErr;
  createdId = created.user.id;
  console.log(`1. admin.createUser: ok id=${createdId.slice(0, 8)}…`);
  console.log(
    `   email_confirmed_at set: ${Boolean(created.user.email_confirmed_at)}`,
  );

  const { data: signIn, error: signInErr } = await anon.auth.signInWithPassword(
    { email, password },
  );
  if (signInErr) throw signInErr;
  const claim1 = decodeClaim(signIn.session!.access_token);
  console.log(
    `2. signInWithPassword: ok; claim app_metadata=${JSON.stringify(claim1?.app_metadata)}`,
  );

  const { error: metaErr } = await admin.auth.admin.updateUserById(createdId, {
    app_metadata: { probe: true, amisibiz_session_version: 1 },
  });
  if (metaErr) throw metaErr;
  console.log(`3. updateUserById(app_metadata bump): ok`);

  const { data: refreshed, error: refreshErr } = await anon.auth.refreshSession(
    {
      refresh_token: signIn.session!.refresh_token,
    },
  );
  if (refreshErr) throw refreshErr;
  const claim2 = decodeClaim(refreshed.session!.access_token);
  console.log(
    `4. refreshSession: ok; new claim app_metadata=${JSON.stringify(claim2?.app_metadata)}`,
  );
  console.log(
    `   refresh token rotated: ${refreshed.session!.refresh_token !== signIn.session!.refresh_token}`,
  );

  const { error: oldAccessErr } = await anon.auth.getUser(
    signIn.session!.access_token,
  );
  console.log(
    `5. getUser(old access token after bump): ${oldAccessErr ? "error — " + oldAccessErr.message : "ok (access tokens are not revoked by app_metadata; server-side claim check is required)"}`,
  );

  const { error: banErr } = await admin.auth.admin.updateUserById(createdId, {
    ban_duration: "1s",
  });
  if (banErr) throw banErr;
  console.log(`6. ban(1s): ok`);

  const preBanRefresh = refreshed.session!.refresh_token;
  const { error: afterBanErr } = await anon.auth.refreshSession({
    refresh_token: preBanRefresh,
  });
  console.log(
    `7. refresh with pre-ban token while banned: ${afterBanErr ? "FAILED — " + afterBanErr.message : "ok (unexpected)"}`,
  );

  const { error: unbanErr } = await admin.auth.admin.updateUserById(createdId, {
    ban_duration: "none",
  });
  if (unbanErr) throw unbanErr;
  console.log(`8. unban: ok`);

  await new Promise((r) => setTimeout(r, 1500));

  const { error: preBanAfterUnbanErr } = await anon.auth.refreshSession({
    refresh_token: preBanRefresh,
  });
  console.log(
    `8b. refresh with pre-ban token after unban: ${preBanAfterUnbanErr ? "FAILED — sessions were deleted (permanent kill)" : "ok (sessions survived the ban)"}`,
  );

  const { error: afterUnbanSignInErr } = await anon.auth.signInWithPassword({
    email,
    password,
  });
  console.log(
    `9. sign-in after unban: ${afterUnbanSignInErr ? "FAILED — " + afterUnbanSignInErr.message : "ok"}`,
  );
} catch (err) {
  failed = true;
  console.error(
    "[probe] ERROR:",
    err instanceof Error ? err.message : JSON.stringify(err),
  );
} finally {
  if (createdId) {
    const { error: deleteErr } = await admin.auth.admin.deleteUser(createdId);
    console.log(
      deleteErr
        ? `10. deleteUser FAILED: ${deleteErr.message}`
        : `10. deleteUser: ok (probe user cleaned up)`,
    );
    if (deleteErr) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
