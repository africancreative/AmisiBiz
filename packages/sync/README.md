# @amisibiz/sync

Offline-synchronization contracts shared by the offline-capable clients
(`apps/mobile`, `apps/desktop`) and — later — the server sync service.

**Contracts only.** Nothing in this package is implemented or wired yet: the
offline architecture is designed in Phase 04.5d and implemented in a later
phase. These interfaces exist so the shells are scaffolded against a stable
shape instead of inventing their own.

- `src/queue.ts` — the local operation queue. Every operation carries a
  **client-generated UUID** that doubles as its server-side idempotency key;
  retrying a push can never double-apply.
- `src/transport.ts` — the push/pull seam against the server.
- `src/conflicts.ts` — conflict records and resolution strategies. Device
  clocks are never the tie-breaker; resolution always needs a server outcome
  or an explicit user decision.

Constitution rules encoded in these types: no fabricated sync success, no
duplicate application on retry, no device-timestamp-only conflict resolution,
and a local value is never authoritative proof of server-side state.
