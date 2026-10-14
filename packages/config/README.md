# @amisibiz/config

Shared TypeScript, ESLint and tooling configuration for every AmisiBiz
workspace. Private — never published.

## TypeScript

| Preset                  | Use for                                          |
| ----------------------- | ------------------------------------------------ |
| `tsconfig/base.json`    | Platform-neutral packages (no DOM, no JSX)       |
| `tsconfig/library.json` | React component packages (`react-jsx`, DOM libs) |
| `tsconfig/nextjs.json`  | The Next.js app (`jsx: preserve`, Next plugins)  |

Every preset keeps the repository-wide strictness guarantees
(`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`moduleResolution: bundler`, `noEmit`).

```json
{ "extends": "@amisibiz/config/tsconfig/library.json" }
```

## ESLint

`@amisibiz/config/eslint` exports the shared flat-config base
(`typescript-eslint` recommended + unused-code rules + standard ignores).

Platform-neutral packages:

```js
import base from "@amisibiz/config/eslint";
export default base;
```

The web app composes the base with the Next.js presets in its own
`eslint.config.mjs`.

## Prettier

One repository-wide `.prettierrc.json` at the root on purpose: formatting
never varies per workspace.
