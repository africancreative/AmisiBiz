# @amisibiz/mobile — Capacitor (Android) shell

Scaffold only. The Android platform has **not** been added to the repository;
this package exists so the shell is configured, pinnable and documented.

## Why Capacitor

The constitution mandates Capacitor for Android: it reuses the platform-neutral
pieces of the product (`@amisibiz/ui` React components, `@amisibiz/domain`,
`@amisibiz/documents`, `@amisibiz/sync`) inside a native shell instead of
duplicating the product in a second UI stack.

## Feasibility (verified on this machine)

| Requirement     | Status                                                     |
| --------------- | ---------------------------------------------------------- |
| JDK 17          | Present (verified)                                         |
| Android SDK     | Present at `C:\src\Android` (`ANDROID_HOME` set, verified) |
| Node/pnpm       | Present (workspace toolchain)                              |
| @capacitor/core | `^8.5.3` (registry-verified)                               |

## First-run commands (not yet executed — deliberate)

```bash
pnpm --filter @amisibiz/mobile cap:add:android   # one-time: generates android/
pnpm --filter @amisibiz/mobile cap:sync          # copy web assets + plugins
pnpm --filter @amisibiz/mobile cap:open:android  # opens Android Studio
```

A release build additionally needs a signing keystore and the Play Console
account — both are out of scope until the app is ready for submission.

## Roadmap position

- **Now (Phase 1):** configured shell, placeholder `web/` assets.
- **Offline phase:** the client becomes offline-first — SQLite storage plus the
  operation queue from `@amisibiz/sync`; the shell will bundle the actual
  client UI instead of a remote URL.
- No `server.url` is configured: the shell must never silently load an
  unreviewed remote origin.

## Phase 6 status — offline stack in, **no Android build yet** (2026-10-15)

The offline client's storage layer is implemented in `@amisibiz/offline` (SQLite schema,
checksummed migration runner, repositories, durable outbox, `SyncClient`), and the
Capacitor driver is pinned against `@capacitor-community/sqlite` 8.1.1 with
`isSQL92: true` — the mode this schema needs, because the default mode rejects the
column defaults the local tables use.

What has **not** happened: `android/` has still not been generated, no Gradle build has
run, and the driver has never executed on a device or emulator. So the runtime
behaviours the directive asks for (open the DB, persist a contact offline, create a
quotation draft, restart and recover, synchronize, retry without duplicates) are
demonstrated here only against `node:sqlite` on Windows — 31 storage tests plus 17
sync-engine tests — and **not** on Android. The last step also cannot be exercised
end-to-end until `/api/sync/push` and `/api/sync/pull` exist. Prerequisites and the
exact commands stay in the section above;
`docs/architecture/offline-client-design.md` §10 and §12 record what is built and what
is not.

## Security

The shell only ever holds the user's own session. The Supabase secret key
(`sb_secret_*`) must **never** appear in a mobile bundle, log or error message
(constitution); all privileged operations happen server-side.
