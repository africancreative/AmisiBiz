import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor shell configuration (Android target).
 *
 * Deliberate choices:
 * - `webDir: "web"` — a bundled local placeholder for now. The offline-first
 *   client (SQLite + `@amisibiz/sync` operation queue) replaces it in the
 *   offline phase; no `server.url` is set so the shell never silently loads
 *   an unreviewed remote origin.
 * - The Android platform is NOT added to the repository yet (see README for
 *   the exact commands and prerequisites).
 * - Security: the shell only ever holds the user's own session tokens; the
 *   Supabase secret key must never reach this bundle (constitution).
 */
const config: CapacitorConfig = {
  appId: "com.amisigenuine.amisibiz",
  appName: "AmisiBiz",
  webDir: "web",
};

export default config;
