import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import { shared } from "@amisibiz/config/eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

// Next.js presets first (they register the plugins), then the shared overlay
// so the workspace-wide rule tuning wins. Formatting stays with Prettier;
// correctness with tsc.
const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  ...shared,
  {
    rules: {
      "react/no-unescaped-entities": "warn",
    },
  },
];

export default eslintConfig;
