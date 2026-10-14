/**
 * Stub for the `server-only` package under Vitest.
 *
 * The real module throws unless bundled with the react-server condition. Unit
 * tests exercise server modules directly, so the guard is neutralised here
 * (aliased in vitest.config.ts). The guard still applies in real Next.js
 * builds.
 */
export {};
