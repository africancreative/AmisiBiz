import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session-user";
import { PERMISSIONS } from "@amisibiz/auth";
import {
  authorizeTenant,
  type TenantAuthzContext,
} from "@/server/auth/authorization";
import { prisma } from "@amisibiz/database";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  logoSizeProblem,
  storeTenantLogo,
  validateLogoBytes,
} from "@/server/services/logo-storage";
import { z } from "zod";

/**
 * Tenant logo upload.
 *
 * Trust order: the session is the only identity source, the tenant id is
 * re-authorized against membership, and the file is classified from its own
 * bytes rather than its name or its declared MIME type. Raster formats only —
 * SVG is excluded because it can carry scripts.
 *
 * The classification and storage themselves live in `server/services/logo-storage`
 * so the provider-side upload route (`/api/platform/tenants/[tenantId]/logo`)
 * applies exactly the same rules; this handler only decides WHO may write.
 */

const uploadRequestSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
});

export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Unauthenticated" },
        { status: 401 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const tenantIdRaw = formData.get("tenantId");

    if (!(file instanceof File) || typeof tenantIdRaw !== "string") {
      return NextResponse.json(
        { success: false, error: "Missing file or tenant ID" },
        { status: 400 },
      );
    }

    const parsedTenant = uploadRequestSchema.safeParse({
      tenantId: tenantIdRaw,
    });
    if (!parsedTenant.success) {
      return NextResponse.json(
        { success: false, error: "Invalid tenant ID" },
        { status: 400 },
      );
    }

    let context: TenantAuthzContext;
    try {
      context = await authorizeTenant(
        user.id,
        parsedTenant.data.tenantId,
        PERMISSIONS.BUSINESS_SETTINGS_UPDATE,
      );
    } catch {
      return NextResponse.json(
        { success: false, error: "Not permitted" },
        { status: 403 },
      );
    }

    // The authorized tenant, re-read from the context the authorization service
    // built — not the value that arrived in the form. They are equal whenever
    // authorization succeeded, but writing the derived one means a future edit
    // cannot quietly reintroduce the raw request field as the storage path.
    const tenantId = context.tenantId;

    if (context.readonly) {
      // A support context may never write. The permission matrix already
      // excludes every write permission from the grant set, and
      // `has_tenant_write_access()` has no support branch; this refusal is the
      // same fact stated once more where a reviewer can see it.
      return NextResponse.json(
        { success: false, error: "Support access is read-only" },
        { status: 403 },
      );
    }

    const sizeProblem = logoSizeProblem(file.size);
    if (sizeProblem) {
      return NextResponse.json(
        { success: false, error: sizeProblem },
        { status: 400 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const validation = validateLogoBytes(buffer, file.type);
    if (!validation.ok) {
      return NextResponse.json(
        { success: false, error: validation.error },
        { status: 400 },
      );
    }

    const { fileName, logoUrl } = await storeTenantLogo(
      tenantId,
      buffer,
      validation.mimeType,
    );

    await prisma.tenantBranding.upsert({
      where: { tenantId },
      create: { tenantId, logoUrl },
      update: { logoUrl },
    });

    await recordAudit({
      action: AUDIT_ACTIONS.BRANDING_LOGO_UPLOADED,
      userId: user.id,
      tenantId,
      resource: "TenantBranding",
      resourceId: tenantId,
      metadata: { field: "logoUrl", fileName },
    });

    return NextResponse.json({ success: true, data: { logoUrl } });
  } catch (err) {
    console.error("[POST /api/branding/logo]", err);
    return NextResponse.json(
      { success: false, error: "Upload failed" },
      { status: 500 },
    );
  }
}
