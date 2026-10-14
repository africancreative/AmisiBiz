# @amisibiz/desktop — Tauri 2 (Windows) shell

Scaffold only. The Rust/Tauri project is configured but **has not been
compiled on this machine** — see feasibility below. This package exists so
the shell is pinned, configured and documented.

## Why Tauri

The constitution mandates Tauri for Windows: a small native shell that reuses
the platform-neutral product packages (`@amisibiz/ui`, `@amisibiz/domain`,
`@amisibiz/documents`, `@amisibiz/sync`) instead of duplicating the product.

## Feasibility (checked on this machine)

| Requirement                  | Status                                   |
| ---------------------------- | ---------------------------------------- |
| Node/pnpm                    | Present (workspace toolchain)            |
| @tauri-apps/cli              | `^2.12.2` (registry-verified)            |
| Rust toolchain (cargo/rustc) | **NOT installed** — cannot compile here  |
| MSVC C++ Build Tools         | Not verified (needed for Windows builds) |
| WebView2 runtime             | Preinstalled on Windows 10/11            |

`tauri dev` / `tauri build` require the Rust toolchain; they have **not** been
run in this environment, and no build success is claimed.

## Prerequisites & first build (Windows)

1. Install Rust (rustup) and the Visual Studio Build Tools with the
   “Desktop development with C++” workload.
2. Regenerate native icons from the brand logo (once — already generated in
   `src-tauri/icons/` from `apps/web/public/brand/amisi-genuine-logo.png`):

   ```bash
   pnpm --filter @amisibiz/desktop tauri icon ../web/public/brand/amisi-genuine-logo.png
   ```

3. Run the shell (loads the placeholder in `web/` for now):

   ```bash
   pnpm --filter @amisibiz/desktop tauri:dev
   ```

4. Windows installers (`.msi` / NSIS `.exe`) are produced by
   `pnpm --filter @amisibiz/desktop tauri:build`.

## Roadmap position

- **Now (Phase 1):** configured shell, placeholder `web/` assets, core
  capabilities only.
- **Offline phase:** the client becomes offline-first — SQLite via
  `@tauri-apps/plugin-sql` plus the operation queue from `@amisibiz/sync`; new
  capabilities are added least-privilege and reviewed.

## Security

The shell only ever holds the user's own session. The Supabase secret key
(`sb_secret_*`) must **never** appear in a desktop bundle, log or error
message (constitution); all privileged operations happen server-side.
