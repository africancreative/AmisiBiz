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

## Phase 6 status — **blocked, not built** (2026-10-15)

No Windows installer exists and none is claimed. Two independent blockers, both
verified rather than assumed:

1. **Toolchain absent on this machine:** no `cargo`/`rustc`/`rustup` and no MSVC C++
   workload (only Windows Kits 10), so `pnpm --filter @amisibiz/desktop tauri build`
   cannot compile even the existing configured shell.
2. **`@tauri-apps/plugin-sql` 2.6.0 cannot run this storage layer as designed**
   (checked against the installed package, not its docs): it exposes `execute`,
   `select`, `load` and `close` and **no transaction API**, while every multi-row local
   write (document + lines + snapshot + outbox entry in one transaction) must be atomic;
   and it binds `$1, $2, …` where the shared SQL layer emits `?`. `tauriSqlDriver`
   therefore **refuses `transaction()` at runtime** with a message naming the reason,
   instead of degrading it into a statement sequence that can half-write a document — a
   silently non-atomic driver is a data-loss bug wearing a compatibility badge.

What Phase 6 did land is platform-independent: the schema, migration runner,
repositories, outbox and sync engine are implemented once in `@amisibiz/offline` and
executed against real SQLite through the `node:sqlite` driver
(`apps/web/tests/phase06-*.test.ts`). Unblocking Windows means installing the Rust +
MSVC toolchain **and** either a Tauri SQL plugin with transactions or a documented
restructure of the write paths. See
`docs/architecture/offline-client-design.md` §3 and §12.

## Security

The shell only ever holds the user's own session. The Supabase secret key
(`sb_secret_*`) must **never** appear in a desktop bundle, log or error
message (constitution); all privileged operations happen server-side.
