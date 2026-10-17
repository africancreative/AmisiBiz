import { describe, it, expect, vi, beforeEach } from "vitest";
import type { z } from "zod";

/**
 * AGENT 4 — acceptance gate.
 *
 * The directive closes with a list of properties the business workspace must
 * provably have. Most of them are already asserted where they live — catalogue
 * and contact writes in `phase04-security.test.ts`, customer-specific pricing
 * precedence in `phase04-customer-pricing.test.ts`, logo upload verification in
 * `phase04-logo-storage.test.ts`, portal linking in
 * `agent4-portal-access.test.ts`. This suite carries the two lines that were not
 * yet proven anywhere, and carries them in the shape the gate asks for:
 *
 *  1. **"All important forms have validation and error-state tests."** There is
 *     no DOM/RTL harness in this project (`environment: node`), so a form's
 *     error state is a function of its schema: the field paths it reports and the
 *     `ActionResult` a Server Action builds from them. Both halves are tested
 *     here against the four forms AGENT 4 ships — customer, catalogue item,
 *     customer-specific item, branding — plus the shared error helper.
 *  2. **"Branding changes affect only the correct tenant"** and **"archived
 *     records do not corrupt historical documents"**, at the action layer: what
 *     Prisma is actually asked to write, and what it is NOT asked to write.
 *
 * The fake tables are strict on purpose: a query that lost its tenant predicate
 * matches nothing here, so a missing filter fails a test instead of quietly
 * returning a foreign row.
 */

vi.mock("@amisibiz/database", () => import("./prisma-mock"));
vi.mock("@/lib/auth/session-user", () => import("./auth-mock"));
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(),
}));

import { prismaMock, auditsFor } from "./prisma-mock";
import { authMock } from "./auth-mock";
import { AUDIT_ACTIONS } from "@/lib/audit";
import { invalidInput } from "@/server/actions/_shared";
import {
  addressFormSchema,
  contactFormSchema,
  CONTACT_FORM_DEFAULT_VALUES,
} from "@/lib/validations/contact";
import {
  itemFormSchema,
  createItemSchema,
  ITEM_FORM_DEFAULT_VALUES,
} from "@/lib/validations/item";
import {
  contactItemFormSchema,
  CONTACT_ITEM_FORM_DEFAULT_VALUES,
} from "@/lib/validations/contact-item";
import {
  brandingFormSchema,
  BRANDING_DEFAULT_VALUES,
} from "@/lib/validations/branding";
import { updateTenantBrandingAction } from "@/server/actions/branding";
import { archiveContactAction } from "@/server/actions/contact";

const ACTOR_ID = "44444444-4444-4444-8444-444444444444";
const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT_ID = "22222222-2222-4222-8222-222222222222";
const CONTACT_ID = "33333333-3333-4333-8333-333333330001";
const ITEM_ID = "55555555-5555-4555-8555-555555555555";
const RATE_ID = "66666666-6666-4666-8666-666666666666";

// ─── Schema harness ───────────────────────────────────────────────────────────

/**
 * The field paths a form would highlight, or `null` when the value was accepted.
 *
 * Asserting on paths (not only on "it failed") is what makes these error-state
 * tests: a rejection the UI cannot attach to a field is indistinguishable, from
 * the user's side, from a form with no validation at all.
 */
function rejected(
  schema: z.ZodTypeAny,
  value: unknown,
): Record<string, string[] | undefined> | null {
  const parsed = schema.safeParse(value);
  return parsed.success
    ? null
    : (parsed.error.flatten().fieldErrors as Record<
        string,
        string[] | undefined
      >);
}

/** Acceptance, with the rejection rendered into the failure message. */
function accepted(schema: z.ZodTypeAny, value: unknown) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `expected acceptance, got ${JSON.stringify(parsed.error.issues)}`,
    );
  }
  return parsed.data;
}

/** One valid address, because the form schema requires the whole shape. */
const address = {
  type: "PHYSICAL" as const,
  line1: "12 Ngong Road",
  line2: "",
  city: "Nairobi",
  state: "",
  postalCode: "",
  country: "KE",
  isDefault: true,
};

const customer = {
  ...CONTACT_FORM_DEFAULT_VALUES,
  firstName: "Amina",
  lastName: "Otieno",
  email: "amina@example.com",
};

const item = {
  ...ITEM_FORM_DEFAULT_VALUES,
  name: "Steel door",
  unitPrice: "4500.0000",
};

const agreement = {
  ...CONTACT_ITEM_FORM_DEFAULT_VALUES,
  itemId: ITEM_ID,
  agreedPrice: "3750.00",
  discountPercent: "5",
};

const branding = { ...BRANDING_DEFAULT_VALUES, displayName: "Acme Ltd" };

// ─── Customer form ────────────────────────────────────────────────────────────

describe("AGENT 4 form validation — customer", () => {
  it("accepts the documented defaults once a name is present", () => {
    accepted(contactFormSchema, customer);
  });

  it("refuses an individual with no name at all, on the field the user is editing", () => {
    const errors = rejected(contactFormSchema, {
      ...customer,
      firstName: "",
      lastName: "   ",
    });
    expect(errors).not.toBeNull();
    expect(errors?.firstName).toContain(
      "Individual contacts require a first or last name",
    );
  });

  it("refuses a business with no company name, on companyName", () => {
    const errors = rejected(contactFormSchema, {
      ...customer,
      type: "BUSINESS",
      companyName: "",
    });
    expect(errors?.companyName).toContain(
      "Business contacts require a company name",
    );
  });

  it("refuses a malformed email but allows an empty one", () => {
    expect(
      rejected(contactFormSchema, { ...customer, email: "not-an-email" })
        ?.email,
    ).toContain("Please enter a valid email address");
    accepted(contactFormSchema, { ...customer, email: "" });
  });

  it("refuses a third address, which is all the schema stores", () => {
    const errors = rejected(contactFormSchema, {
      ...customer,
      addresses: [
        address,
        address,
        { ...address, type: "POSTAL", isDefault: false },
      ],
    });
    expect(errors?.addresses).toContain("At most two addresses");
  });

  it("refuses a country that is not a 2-letter code", () => {
    const errors = rejected(addressFormSchema, {
      ...address,
      country: "KENYA",
    });
    expect(errors?.country).toContain("Country must be a 2-letter ISO code");
  });

  it("keeps an all-whitespace name out of storage by trimming first", () => {
    const data = accepted(contactFormSchema, {
      ...customer,
      firstName: "  Amina  ",
    }) as typeof customer;
    expect(data.firstName).toBe("Amina");
  });
});

// ─── Catalogue form ───────────────────────────────────────────────────────────

describe("AGENT 4 form validation — catalogue item", () => {
  it("accepts a plain product priced in exact decimals", () => {
    accepted(itemFormSchema, item);
  });

  it("refuses an item with no name", () => {
    expect(rejected(itemFormSchema, { ...item, name: "" })?.name).toContain(
      "Name is required",
    );
  });

  it("refuses a price that is not a decimal string, and one with too many places", () => {
    expect(
      rejected(itemFormSchema, { ...item, unitPrice: "1,200.00" })?.unitPrice,
    ).toContain("Enter a number with up to 4 decimal places");
    expect(
      rejected(itemFormSchema, { ...item, unitPrice: "10.12345" })?.unitPrice,
    ).toContain("Enter a number with up to 4 decimal places");
  });

  it("refuses a price large enough to lose exactness", () => {
    expect(
      rejected(itemFormSchema, { ...item, unitPrice: "1000000000000" })
        ?.unitPrice,
    ).toContain("Amount is too large");
  });

  it("refuses a SKU that is only whitespace, which is a typo and not an omission", () => {
    // The form trims, so a space-only SKU becomes the legitimate "no SKU"; the
    // payload the Server Action validates is where the typo is refused outright.
    expect(accepted(itemFormSchema, { ...item, sku: "   " })).toHaveProperty(
      "sku",
      "",
    );
    expect(
      rejected(createItemSchema, {
        tenantId: TENANT_ID,
        name: "Widget",
        sku: "   ",
        unitPrice: "10",
      })?.sku,
    ).toContain("SKU cannot be empty if provided");
  });

  it("refuses a unit of measure or a currency outside the controlled lists", () => {
    const errors = rejected(itemFormSchema, {
      ...item,
      unitOfMeasure: "pallets",
      currency: "USDT",
    });
    expect(errors?.unitOfMeasure).toBeDefined();
    expect(errors?.currency).toBeDefined();
  });

  it("treats an empty tax rate as 'no tax rate', and anything else as an id", () => {
    accepted(itemFormSchema, { ...item, taxRateId: "" });
    accepted(itemFormSchema, { ...item, taxRateId: RATE_ID });
    expect(
      rejected(itemFormSchema, { ...item, taxRateId: "tax-2" })?.taxRateId,
    ).toContain("Invalid tax rate ID");
  });

  it("keeps the archive vocabulary honest: an item is ACTIVE or INACTIVE", () => {
    expect(
      rejected(itemFormSchema, { ...item, status: "ARCHIVED" })?.status,
    ).toBeDefined();
  });
});

// ─── Customer-specific terms form ─────────────────────────────────────────────

describe("AGENT 4 form validation — customer-specific item", () => {
  it("accepts an agreed price with a discount and no validity window", () => {
    accepted(contactItemFormSchema, agreement);
  });

  it("refuses an agreed price that is not exact decimals", () => {
    expect(
      rejected(contactItemFormSchema, { ...agreement, agreedPrice: "3750,00" })
        ?.agreedPrice,
    ).toContain("Enter a number with up to 4 decimal places");
  });

  it("refuses a discount outside 0–100", () => {
    expect(
      rejected(contactItemFormSchema, { ...agreement, discountPercent: "101" })
        ?.discountPercent,
    ).toContain("Must be between 0 and 100");
  });

  it("refuses a validity window that runs backwards, on the closing date", () => {
    const errors = rejected(contactItemFormSchema, {
      ...agreement,
      validFrom: "2026-06-30",
      validUntil: "2026-06-01",
    });
    expect(errors?.validUntil).toContain(
      "The valid-until date must not be before the valid-from date.",
    );
  });

  it("accepts a window open at either end — an absent date never expires the terms", () => {
    accepted(contactItemFormSchema, {
      ...agreement,
      validFrom: "",
      validUntil: "",
    });
    accepted(contactItemFormSchema, { ...agreement, validFrom: "2026-01-01" });
    accepted(contactItemFormSchema, { ...agreement, validUntil: "2026-12-31" });
  });

  it("refuses a date the browser sent in some other shape", () => {
    expect(
      rejected(contactItemFormSchema, { ...agreement, validFrom: "01/01/2026" })
        ?.validFrom,
    ).toContain("Enter a date");
  });
});

// ─── Branding form ────────────────────────────────────────────────────────────

describe("AGENT 4 form validation — branding", () => {
  it("accepts the documented palette and layout", () => {
    accepted(brandingFormSchema, branding);
  });

  it("refuses a colour that is not a bare hex value — CSS injection", () => {
    for (const value of [
      "#1d4ed8; body{display:none}",
      "red",
      "#1d4",
      "1d4ed8",
    ]) {
      const errors = rejected(brandingFormSchema, {
        ...branding,
        primaryColor: value,
      });
      expect(errors?.primaryColor, value).toContain(
        "Must be a valid hex colour (e.g. #1d4ed8)",
      );
    }
  });

  it("refuses a website that is not an absolute http(s) URL", () => {
    for (const value of [
      "javascript:alert(1)",
      "data:text/html,x",
      "acme.example",
    ]) {
      expect(
        rejected(brandingFormSchema, { ...branding, website: value })?.website,
        value,
      ).toBeDefined();
    }
    accepted(brandingFormSchema, {
      ...branding,
      website: "https://acme.example",
    });
    accepted(brandingFormSchema, { ...branding, website: "" });
  });

  it("refuses a layout outside the three the renderer implements", () => {
    expect(
      rejected(brandingFormSchema, { ...branding, documentLayout: "fancy" })
        ?.documentLayout,
    ).toBeDefined();
  });

  it("refuses a currency the documents cannot price", () => {
    expect(
      rejected(brandingFormSchema, { ...branding, currency: "XBT" })?.currency,
    ).toBeDefined();
  });

  it("bounds the long free-text fields so a footer cannot grow without limit", () => {
    expect(
      rejected(brandingFormSchema, {
        ...branding,
        paymentInstructions: "x".repeat(2001),
      })?.paymentInstructions,
    ).toBeDefined();
  });
});

// ─── The error state a form renders ──────────────────────────────────────────

describe("AGENT 4 error state", () => {
  /** Loosely re-typed `ActionResult`; the union narrows `.data`/`.fieldErrors`. */
  function loose(result: unknown) {
    return result as {
      success: boolean;
      error?: string;
      code?: string;
      fieldErrors?: Record<string, string[]>;
    };
  }

  it("turns a rejected payload into per-field messages, not a raw exception", () => {
    const parsed = contactFormSchema.safeParse({
      ...customer,
      firstName: "",
      lastName: "",
    });
    if (parsed.success) throw new Error("fixture should not validate");
    const state = loose(
      invalidInput(parsed.error, "Please correct the highlighted fields."),
    );
    expect(state.success).toBe(false);
    expect(state.code).toBe("VALIDATION_ERROR");
    expect(state.error).toBe("Please correct the highlighted fields.");
    expect(state.fieldErrors?.firstName).toHaveLength(1);
  });

  it("carries no field errors for a failure that never came from a schema", () => {
    const state = loose(invalidInput(new Error("boom"), "Invalid input."));
    expect(state.code).toBe("VALIDATION_ERROR");
    expect(state.fieldErrors).toBeUndefined();
  });

  it("never echoes the submitted values back through the failure message", () => {
    const parsed = contactFormSchema.safeParse({
      ...customer,
      // Invalid only in the name, so the e-mail and PIN below are present in
      // the payload exactly as the user typed them.
      firstName: "",
      lastName: "",
      email: "secret-address@example.com",
      taxPin: "A991234567",
    });
    if (parsed.success) throw new Error("fixture should not validate");
    const state = loose(invalidInput(parsed.error));
    expect(state.fieldErrors?.firstName).toBeDefined();
    expect(JSON.stringify(state)).not.toContain("secret-address");
    expect(JSON.stringify(state)).not.toContain("A991234567");
  });
});

// ─── Fixtures for the action layer ────────────────────────────────────────────

type MemberRow = {
  tenantId: string;
  userId: string;
  role: string;
  tenantStatus: "ACTIVE" | "SUSPENDED";
};

let memberships: MemberRow[];
let contactStatus: "ACTIVE" | "ARCHIVED" = "ACTIVE";

function findArg(args: unknown): Record<string, unknown> {
  return (args as { where?: Record<string, unknown> }).where ?? {};
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});

  memberships = [
    {
      tenantId: TENANT_ID,
      userId: ACTOR_ID,
      role: "TENANT_OWNER",
      tenantStatus: "ACTIVE",
    },
  ];
  contactStatus = "ACTIVE";

  authMock.mockResolvedValue({
    id: ACTOR_ID,
    email: "owner@example.com",
    name: "Owner",
    platformRole: null,
    status: "ACTIVE",
  });

  prismaMock.$transaction.mockImplementation(async (arg: unknown) =>
    typeof arg === "function"
      ? await (arg as (tx: unknown) => Promise<unknown>)(prismaMock)
      : await Promise.all(arg as Promise<unknown>[]),
  );

  // The authorization layer's own read of the actor's platform standing.
  prismaMock.user.findUnique.mockResolvedValue({
    platformRole: null,
    status: "ACTIVE",
  });
  prismaMock.supportAccessGrant.findFirst.mockResolvedValue(null);

  prismaMock.tenantMember.findUnique.mockImplementation(
    async (args: unknown) => {
      const key =
        (
          args as {
            where?: {
              tenantId_userId?: { tenantId?: string; userId?: string };
            };
          }
        ).where?.tenantId_userId ?? {};
      const found = memberships.find(
        (row) => row.tenantId === key.tenantId && row.userId === key.userId,
      );
      return found
        ? { role: found.role, tenant: { status: found.tenantStatus } }
        : null;
    },
  );

  prismaMock.contact.findFirst.mockImplementation(async (args: unknown) => {
    const where = findArg(args);
    // Strict on the tenant: a read that forgot its predicate finds nothing.
    if (where.tenantId !== TENANT_ID || where.id !== CONTACT_ID) return null;
    return { id: CONTACT_ID, tenantId: TENANT_ID, status: contactStatus };
  });
  prismaMock.contact.updateMany.mockResolvedValue({ count: 1 });

  prismaMock.tenantBranding.findUnique.mockResolvedValue(null);
  prismaMock.tenantBranding.create.mockResolvedValue({ id: "branding-1" });
  prismaMock.document.count.mockResolvedValue(7);
});

function argOf(mock: unknown, index = 0) {
  const calls = (mock as { mock: { calls: unknown[][] } }).mock.calls;
  return (calls[index]?.[0] ?? {}) as Record<string, unknown>;
}

// ─── Branding affects one tenant ─────────────────────────────────────────────

describe("AGENT 4 branding is confined to its own workspace", () => {
  const payload = {
    tenantId: TENANT_ID,
    displayName: "Acme Ltd",
    primaryColor: "#1d4ed8",
    secondaryColor: "#1e3a5f",
    accentColor: "#f59e0b",
    primaryForeground: "#f8fafc",
    currency: "KES",
    documentLayout: "compact",
    website: "https://acme.example",
  };

  it("writes under the tenant the authorization layer resolved", async () => {
    const result = await updateTenantBrandingAction(payload);
    expect(result.success).toBe(true);

    const created = argOf(prismaMock.tenantBranding.create);
    const data = (created.data ?? {}) as Record<string, unknown>;
    expect(data.tenantId).toBe(TENANT_ID);
    // The lookup that decides update-vs-create is keyed the same way.
    expect(
      findArg(prismaMock.tenantBranding.findUnique.mock.calls[0]?.[0]),
    ).toEqual({ tenantId: TENANT_ID });
  });

  it("refuses to brand a workspace the caller is not a member of, and writes nothing", async () => {
    const result = await updateTenantBrandingAction({
      ...payload,
      tenantId: OTHER_TENANT_ID,
    });
    expect(result.success).toBe(false);
    expect(prismaMock.tenantBranding.create).not.toHaveBeenCalled();
    expect(prismaMock.tenantBranding.update).not.toHaveBeenCalled();
    expect(auditsFor(AUDIT_ACTIONS.BRANDING_UPDATED)).toHaveLength(0);
  });

  it("updates an existing record by its own id, never by a tenant id from the payload", async () => {
    prismaMock.tenantBranding.findUnique.mockResolvedValue({
      id: "branding-9",
    });
    const result = await updateTenantBrandingAction({
      ...payload,
      // A branding row has no tenantId column to patch: the locator is an id, and
      // nothing here may move a record between workspaces.
      logoUrl: "/uploads/tenants/elsewhere/logo.png",
    });
    expect(result.success).toBe(true);

    const arg = argOf(prismaMock.tenantBranding.update);
    expect(arg.where).toEqual({ id: "branding-9" });
    const data = (arg.data ?? {}) as Record<string, unknown>;
    expect(Object.keys(data)).not.toContain("logoUrl");
    expect(Object.keys(data)).not.toContain("tenantId");
  });

  it("refuses the write for a suspended workspace and audits the refusal", async () => {
    memberships = memberships.map((row) => ({
      ...row,
      tenantStatus: "SUSPENDED" as const,
    }));
    const result = await updateTenantBrandingAction(payload);
    expect(result.success).toBe(false);
    expect(prismaMock.tenantBranding.create).not.toHaveBeenCalled();
    expect(auditsFor(AUDIT_ACTIONS.TENANT_WRITE_DENIED)).toHaveLength(1);
  });

  it("audits which fields changed, never their values", async () => {
    await updateTenantBrandingAction({
      ...payload,
      postalAddress: "Private bag 12, Nairobi",
      taxPin: "A991234567",
    });
    const [audit] = auditsFor(AUDIT_ACTIONS.BRANDING_UPDATED);
    const serialized = JSON.stringify(audit?.metadata ?? {});
    expect(serialized).not.toContain("Private bag");
    expect(serialized).not.toContain("A991234567");
    // The event names which fields moved, so an operator can read the trail
    // without the trail itself being a copy of the business's records.
    expect((audit?.metadata as { fields: string[] }).fields).toContain(
      "postalAddress",
    );
  });
});

// ─── Archiving preserves history ──────────────────────────────────────────────

describe("AGENT 4 archiving a customer preserves its documents", () => {
  const payload = { contactId: CONTACT_ID, tenantId: TENANT_ID };

  it("flips the status only — no row and no document is removed", async () => {
    const result = await archiveContactAction(payload);
    expect(result.success).toBe(true);

    const arg = argOf(prismaMock.contact.updateMany);
    const data = (arg.data ?? {}) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(["archivedAt", "status"]);
    expect(data.status).toBe("ARCHIVED");

    // The historical record is the point: nothing here deletes a row.
    expect(prismaMock.contact.delete).not.toHaveBeenCalled();
    expect(prismaMock.contact.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.document.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.document.updateMany).not.toHaveBeenCalled();
  });

  it("pins the write to the authorized tenant and to a still-active row", async () => {
    await archiveContactAction(payload);
    const where = argOf(prismaMock.contact.updateMany).where as Record<
      string,
      unknown
    >;
    expect(where).toEqual({
      id: CONTACT_ID,
      tenantId: TENANT_ID,
      status: "ACTIVE",
    });
  });

  it("reads a contact from another workspace as not found and writes nothing", async () => {
    const result = await archiveContactAction({
      contactId: CONTACT_ID,
      tenantId: OTHER_TENANT_ID,
    });
    expect(result.success).toBe(false);
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a caller without the delete permission", async () => {
    memberships = memberships.map((row) => ({ ...row, role: "VIEWER" }));
    const result = await archiveContactAction(payload);
    expect(result.success).toBe(false);
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
  });

  it("counts the documents that still reference the customer and audits only that", async () => {
    const result = await archiveContactAction(payload);
    expect(result.success).toBe(true);

    // The count is the operator's evidence that history is intact.
    expect(prismaMock.document.count).toHaveBeenCalled();
    const [audit] = auditsFor(AUDIT_ACTIONS.CONTACT_ARCHIVED);
    expect(audit?.metadata).toEqual({ linkedDocuments: 7 });
    expect(JSON.stringify(audit?.metadata ?? {})).not.toContain("Amina");
  });

  it("reports a conflict, not a second write, for an already-archived customer", async () => {
    contactStatus = "ARCHIVED";
    const result = await archiveContactAction(payload);
    expect(result.success).toBe(false);
    expect(prismaMock.contact.updateMany).not.toHaveBeenCalled();
    expect(auditsFor(AUDIT_ACTIONS.CONTACT_ARCHIVED)).toHaveLength(0);
  });
});
