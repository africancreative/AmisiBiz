import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session-user";
import { PERMISSIONS } from "@amisibiz/auth";
import { authorizePlatformTenant } from "@/server/auth/authorization";
import { prisma } from "@amisibiz/database";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import {
  logoSizeProblem,
  storeTenantLogo,
  validateLogoBytes,
} from "@/server/services/logo-storage";
import { z } from "zod";

/**
 * Provider-side logo upload for a tenant's branding.
 *
 * Only authorised platform administrators may set a tenant's logo. The
 * classification, magic-byte checks and storage layout are identical to the
 * tenant route so the two writers cannot diverge. The URL returned is served by
 * the private uploads route, which now also allows platform admins to read a
 * tenant's uploads.
 */

const uploadRequestSchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> },
) {
  try {
    const { tenantId: tenantIdRaw } = await params;

    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: "Unauthenticated" },
        { status: 401 },
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

    try {
      await authorizePlatformTenant(
        user.id,
        parsedTenant.data.tenantId,
        PERMISSIONS.PLATFORM_TENANTS_UPDATE,
      );
    } catch {
      return NextResponse.json(
        { success: false, error: "Not permitted" },
        { status: 403 },
      );
    }

    const tenantId = parsedTenant.data.tenantId;

    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true },
    });
    if (!tenant) {
      return NextResponse.json(
        { success: false, error: "Organisation not found" },
        { status: 404 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { success: false, error: "Missing file" },
        { status: 400 },
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
      action: AUDIT_ACTIONS.PLATFORM_TENANT_LOGO_UPLOADED,
      userId: user.id,
      tenantId,
      resource: "TenantBranding",
      resourceId: tenantId,
      metadata: { field: "logoUrl", fileName },
    });

    return NextResponse.json({ success: true, data: { logoUrl } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[POST /api/platform/tenants/[tenantId]/logo] Upload error:", message, err);
    return NextResponse.json(
      { success: false, error: `Upload failed: ${message}` },
      { status: 500 },
    );
  }
}
