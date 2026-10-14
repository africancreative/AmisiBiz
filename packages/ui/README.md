# @amisibiz/ui

The AmisiBiz React UI kit. Every component is plain React + Tailwind class
names — **no Next.js imports, no runtime-specific dependencies** — so the same
components can render inside the Next.js app today and inside the Capacitor /
Tauri webview shells later. (Per the constitution: incompatible UI libraries
are not forced into one package; anything framework-bound stays in the app.)

- Import components by subpath: `import { Button } from "@amisibiz/ui/button"`.
- `import { cn } from "@amisibiz/ui/utils"` for class-name composition.
- Styling contract: the consuming app owns the Tailwind config and must scan
  this package's sources (`content: [..., "../../packages/ui/src/**/*.{ts,tsx}"]`)
  so the classes these components use are generated.

`src/icons.tsx` holds the self-contained SVG icon set (no icon-library
dependency). Components are presentation-only: no data fetching, no auth, no
tenant logic.
