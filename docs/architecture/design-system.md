# AmisiBiz Design System

Foundation for the AmisiBiz application UI. Implements the product identity
(professional, clean, accessible) for Amisi Genuine Enterprises.

## Design tokens

Tokens live in two deliberately separated layers.

### 1. Provider tokens (product UI)

Defined as HSL channel triplets in `src/styles/globals.css` (`:root`) and mapped
to Tailwind semantic colours in `tailwind.config.ts`:

| Token group | Examples                                              |
| ----------- | ----------------------------------------------------- |
| Surfaces    | `background`, `foreground`, `card`, `muted`, `border` |
| Actions     | `primary`, `secondary`, `accent`, `destructive`       |
| Feedback    | `success`, `warning`, `info`                          |
| Focus       | `ring`                                                |

Provider identity scales are also exposed directly: `brand-*` (Amisi blue) and
`gold-*` (Amisi gold).

### 2. Tenant tokens (tenant documents)

Each business can brand **its own documents** (invoices, quotes, letterheads):

```
--tenant-primary, --tenant-primary-foreground, --tenant-accent, --tenant-accent-foreground
```

Produced by `tenantCssVariables()` in `src/lib/branding/tokens.ts` and applied
by the `<TenantTheme>` wrapper (`src/components/branding/tenant-theme.tsx`).
Tenant tokens are applied **only** to tenant artefacts — never to the provider
product chrome. The `/app/settings/branding` screen demonstrates the separation
with a live document preview.

## Typography, spacing & breakpoints

- Font: Inter (`next/font`), wired as `--font-inter`.
- Tailwind's default type scale, spacing scale and responsive breakpoints
  (`sm` 640, `md` 768, `lg` 1024, `xl` 1280) are used throughout.
- Surfaces use `rounded-lg` / `rounded-md` derived from `--radius`.

## Components (`src/components/ui`)

Reusable, token-driven, accessible building blocks:

- `Button` — variants (primary/secondary/outline/ghost/danger/gold), sizes, loading state
- `Input`, `Textarea`, `Select`, `Field` (label + hint + error, ARIA-wired)
- `Card` (+ header/title/description/content/footer)
- `Badge`, `StatusIndicator` (never colour-only)
- `Table` primitives (+ scroll container)
- `Alert` (inline notifications), `Toast` (transient notifications)
- `Dialog` (native `<dialog>`, focus-trapped), `Spinner`
- `LoadingState`, `EmptyState`, `ErrorState`, `PageHeader`
- `icons` — inline SVG set (no external icon dependency)

## Layouts (`src/components/layout`)

- `AuthShell` — centred authentication screens (provider branding only)
- `WorkspaceShell` — `/app/*`; desktop sidebar, mobile drawer, sticky header
- `AdminShell` — `/admin/*`; visually distinct platform (provider) chrome

Navigation is rendered by `NavLinks` (active state via `usePathname`) and
`MobileNav` (native `<dialog>` drawer with `aria-expanded`).

## Accessibility

- Real `<label>` associations via `Field`; `aria-describedby` / `aria-invalid`.
- Visible focus rings (`:focus-visible`) driven by the `ring` token.
- Keyboard-operable dialogs and drawers (native `<dialog>`, Esc to close).
- Status/feedback conveyed with text, not colour alone (`StatusIndicator`,
  `role="status"`/`role="alert"` live regions).

## Validation & errors

- Shared Zod primitives in `src/lib/validation/common.ts` (email, password, id,
  slug, pagination).
- Typed error conventions in `src/lib/errors.ts` (`ActionResult`, `AppError`,
  `toActionResult`); every Server Action returns an `ActionResult`.

## Health check

`GET /api/health` returns only `status`, `service` and a timestamp — no
secrets, connection strings or infrastructure details.
