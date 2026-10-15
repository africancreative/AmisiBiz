import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@amisibiz/database";
import { getSessionUser } from "@/lib/auth/session-user";
import { recordAudit, AUDIT_ACTIONS } from "@/lib/audit";
import { DocumentServiceError } from "@/server/services/documents/errors";
import { resolvePortalContext } from "@/server/services/documents/portal";
import {
  documentPdfFilename,
  renderDocumentSnapshotPdf,
} from "@/server/services/documents/render";

/**
 * Customer-portal document download:
 * `GET /api/portal/documents/<documentId>/pdf?tenantId=<uuid>`.
 *
 * This route is the WHOLE of a portal user's document access. It:
 *   1. requires the portal read permission (only CUSTOMER_PORTAL_USER has it);
 *   2. resolves the single `Contact` the user is linked to in this tenant; and
 *   3. reads the document with `contactId = thatContact` in the WHERE clause.
 *
 * Step 3 is the security boundary: the contact id is not a filter applied after
 * the fact, it is part of the query, so a document belonging to any other
 * customer simply does not exist for this caller (404, indistinguishable from a
 * bad id). A number in a URL is not a capability — the session and the link are.
 *
 * Downloads are streamed inline; there is no permanent public URL, and the
 * response is `no-store` so nothing is cached past the request.
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
    const search = new URL(request.url).searchParams;
    const parsed = querySchema.safeParse({
      tenantId: search.get("tenantId") ?? undefined,
      disposition: search.get("disposition") ?? undefined,
    });
    if (!parsed.success || !z.string().uuid().safeParse(documentId).success) {
      return errorResponse(400, "Invalid request");
    }

    const user = await getSessionUser();
    if (!user) {
      return errorResponse(401, "Unauthenticated");
    }

    let portal;
    try {
      portal = await resolvePortalContext(user.id, parsed.data.tenantId);
    } catch (error) {
      if (error instanceof DocumentServiceError && error.code === "FORBIDDEN") {
        return errorResponse(403, "Not permitted");
      }
      return errorResponse(403, "Not permitted");
    }

    const document = await prisma.document.findFirst({
      where: {
        id: documentId,
        tenantId: portal.authz.tenantId,
        // The link, in the query: a portal user may only ever fetch their own.
        contactId: portal.contactId,
      },
      select: { type: true, number: true, snapshot: true },
    });
    if (!document) {
      return errorResponse(404, "Not found");
    }

    const tenant = await prisma.tenant.findUnique({
      where: { id: portal.authz.tenantId },
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
      action: AUDIT_ACTIONS.DOCUMENT_PORTAL_DOWNLOADED,
      userId: user.id,
      tenantId: portal.authz.tenantId,
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
    console.error("[GET /api/portal/documents/[documentId]/pdf]", err);
    return errorResponse(500, "Download failed");
  }
}
