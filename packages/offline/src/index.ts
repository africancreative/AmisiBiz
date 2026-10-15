/**
 * `@amisibiz/offline` — the storage layer beneath an installed client.
 *
 * The public surface is deliberately narrow: open a database through one of the
 * three drivers, get a `LocalDb`, and work through its repositories. The pull
 * appliers, the sync-state helpers and the checksum machinery are exported
 * because the synchronization client and the test batteries need them, not
 * because an app should call them directly — a screen that writes a row with
 * `setSyncState` instead of a repository has bypassed the outbox.
 *
 * Nothing in here contacts a network, holds a credential, or decides what a
 * user is allowed to do. Authorization is the server's (design §6); this layer
 * records what the server last said and enforces exactly one local rule: the
 * data on the device belongs to one tenant.
 */

export * from "./types";
export * from "./driver";
export * from "./ids";
export * from "./checksum";
export * from "./constants";
export * from "./schema";
export * from "./migrate";
export * from "./changes";
export * from "./sync-state";
export * from "./exchange";
export * from "./outbox";
export * from "./meta-repository";
export * from "./provisioning";
export * from "./contact-repository";
export * from "./catalogue";
export * from "./document-repository";
export * from "./pull";
export * from "./sync-client";
export * from "./local-db";

export * from "./drivers/node";
export * from "./drivers/capacitor";
export * from "./drivers/tauri";
