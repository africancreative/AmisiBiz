import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@amisibiz/database";
import { getSessionUser } from "@/lib/auth/session-user";
import { PERMISSIONS } from "@amisibiz/auth";
import { authorizeTenant } from "@/server/auth/authorization";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { DocumentServiceError } from "@/server/services/documents/errors";
import {
  documentPdfFilename,
  renderDocumentSnapshotPdf,
} from "@/server/services/documents/render";

/**
 * Staff document download: `GET /api/documents/<documentId>/pdf?tenantId=<uuid>`.
 *
 * Trust order, unchanged from every other private route: the session is the only
 * identity, the tenant is re-authorized against membership (`documents.download`),
 * and the document is then read WITHIN that tenant. A document in another
 * workspace is a 404, never a 403 — the caller must not learn that an id exists
 * somewhere they cannot reach.
 *
 * The bytes come from the frozen snapshot, so the download matches what was
 * issued even if the contact or catalogue moved on. `?disposition=attachment`
 * turns the inline preview into a save; the default (`inline`) is what a browser
 * print dialog needs.
 */

const querySchema = z.object({
  tenantId: z.string().uuid("Invalid tenant ID"),
  disposition: z.enum(["inline", "attachment"]).default("inline"),
});

function errorResponse(status: number, message: string): NextResponse {
  return NextResponse.json({ success: false, error: message }, { status });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ documentId: string }> },
) {
  try {
    const { documentId } = await params;
    const parsed = querySchema.safeParse({
      tenantId: new URL(request.url).searchParams.get("tenantId") ?? undefined,
      disposition:
        new URL(request.url).searchParams.get("disposition") ?? undefined,
    });
    if (!parsed.success || !z.string().uuid().safeParse(documentId).success) {
      return errorResponse(400, "Invalid request");
    }

    const user = await getSessionUser();
    if (!user) {
      return errorResponse(401, "Unauthenticated");
    }

    let context;
    try {
      context = await authorizeTenant(
        user.id,
        parsed.data.tenantId,
        PERMISSIONS.DOCUMENTS_DOWNLOAD,
      );
    } catch {
      return errorResponse(403, "Not permitted");
    }

    const document = await prisma.document.findFirst({
      where: { id: documentId, tenantId: context.tenantId },
      select: { type: true, number: true, snapshot: true },
    });
    if (!document) {
      return errorResponse(404, "Not found");
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: context.tenantId },
      select: { locale: true },
    });

    let bytes: Uint8Array;
    try {
      bytes = await renderDocumentSnapshotPdf(document, tenant?.locale ?? "en");
    } catch (error) {
      if (error instanceof DocumentServiceError && error.code === "CONFLICT") {
        return errorResponse(409, error.message);
      }
      throw error;
    }

    await recordAudit({
      action: AUDIT_ACTIONS.DOCUMENT_DOWNLOADED,
      userId: user.id,
      tenantId: context.tenantId,
      resource: "Document",
      resourceId: documentId,
      metadata: { number: document.number, type: document.type },
    });

    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(bytes.length),
        "Content-Disposition": `${parsed.data.disposition}; filename="${documentPdfFilename(document.type, document.number)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    console.error("[GET /api/documents/[documentId]/pdf]", err);
    return errorResponse(500, "Download failed");
  }
}
