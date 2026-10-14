import tseslint from "typescript-eslint";
import globals from "globals";

/**
 * Shared ESLint flat-config modules for every AmisiBiz workspace.
 *
 * Rules stay deliberately conservative: formatting is owned by Prettier, and
 * correctness is owned by `tsc` — ESLint guards against unused code and
 * obviously wrong patterns, never against style.
 *
 * Two exports:
 * - `base` (also the default): the full standalone config for platform-neutral
 *   TypeScript packages. It registers the typescript-eslint plugin itself.
 * - `shared`: the same ignores/globals/rules WITHOUT the typescript-eslint
 *   plugin registration, for apps that compose additional presets which
 *   register the plugin themselves (the Next.js presets do — registering it
 *   twice is a flat-config error).
 */

const ignores = {
  ignores: [
    "**/node_modules/**",
    "**/.next/**",
    "**/.turbo/**",
    "**/dist/**",
    "**/coverage/**",
    "**/next-env.d.ts",
    "**/*.tsbuildinfo",
  ],
};

const languageOptions = {
  languageOptions: {
    // Internal workspaces mix renderer code with tooling; scoping globals
    // per file tree would add noise without changing what gets caught.
    globals: { ...globals.browser, ...globals.node, ...globals.es2024 },
  },
};

const rules = {
  rules: {
    "@typescript-eslint/no-unused-vars": [
      "warn",
      {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      },
    ],
    "@typescript-eslint/no-empty-object-type": "warn",
  },
};

/** Plugin-free overlay — safe to compose next to presets that register typescript-eslint. */
export const shared = tseslint.config(ignores, languageOptions, rules);

/** Standalone base for platform-neutral TypeScript packages. */
export const base = tseslint.config(
  ignores,
  ...tseslint.configs.recommended,
  languageOptions,
  rules,
);

export default base;
