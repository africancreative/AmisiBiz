import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // `server-only` throws outside the react-server bundling condition; unit
      // tests exercise server modules directly, so neutralise the guard.
      "server-only": fileURLToPath(
        new URL("./tests/stubs/server-only.ts", import.meta.url),
      ),
      // `next/headers` needs a live Next.js request scope; tests that exercise
      // it mock the module explicitly — this stub keeps unmocked imports inert.
      "next/headers": fileURLToPath(
        new URL("./tests/stubs/next-headers.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/lib/**", "src/server/**"],
    },
  },
});
