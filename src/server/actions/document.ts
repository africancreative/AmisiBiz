"use server";

import { prisma } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import type { Document, Prisma } from "@prisma/client";
import type { ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import {
  documentLocatorSchema,
  documentQuerySchema,
} from "@/lib/validations/document";

export async function getDocumentsAction(rawInput: unknown): Promise<
  ActionResult<{
    /** The list query includes nothing, so rows are plain `Document`s. */
    documents: Document[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }>
> {
  const session = await requireAuth();

  const parsed = documentQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid query parameters.");
  }

  const {
    tenantId,
    contactId,
    search,
    type,
    status,
    page,
    pageSize,
    sortBy,
    sortOrder,
  } = parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DOCUMENTS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getDocumentsAction");
  }

  // Scoped with the authorized tenant id, never the value that arrived.
  const where: Prisma.DocumentWhereInput = {
    tenantId: context.tenantId,
    ...(contactId && { contactId }),
    ...(type && { type }),
    ...(status && { status }),
    ...(search && {
      OR: [
        { number: { contains: search, mode: "insensitive" } },
        { contact: { firstName: { contains: search, mode: "insensitive" } } },
        { contact: { lastName: { contains: search, mode: "insensitive" } } },
        { contact: { companyName: { contains: search, mode: "insensitive" } } },
      ],
    }),
  };

  try {
    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        // sortBy comes from the validated enum, never from free text.
        orderBy: { [sortBy]: sortOrder },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.document.count({ where }),
    ]);

    return {
      success: true,
      data: {
        documents,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    };
  } catch (err) {
    console.error("[getDocumentsAction]", err);
    return {
      success: false,
      error: "Failed to load documents.",
      code: "INTERNAL",
    };
  }
}

/**
 * Contact projection for a single document. Declared once and `satisfies` the
 * Prisma include type so the query and the action's return type can never
 * disagree (the earlier `include: { contact: true }` signature promised a full
 * contact row while the query only selected the identifying fields).
 */
const documentInclude = {
  contact: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      companyName: true,
      email: true,
      type: true,
    },
  },
} satisfies Prisma.DocumentInclude;

export async function getDocumentAction(
  documentId: string,
  tenantId: string,
): Promise<
  ActionResult<{
    document: Prisma.DocumentGetPayload<{
      include: typeof documentInclude;
    }> | null;
  }>
> {
  const session = await requireAuth();

  const parsed = documentLocatorSchema.safeParse({ documentId, tenantId });
  if (!parsed.success) {
    return invalidInput(parsed.error);
  }

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DOCUMENTS_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getDocumentAction");
  }

  try {
    const document = await prisma.document.findFirst({
      where: { id: parsed.data.documentId, tenantId: context.tenantId },
      include: documentInclude,
    });

    return { success: true, data: { document } };
  } catch (err) {
    console.error("[getDocumentAction]", err);
    return {
      success: false,
      error: "Failed to load document.",
      code: "INTERNAL",
    };
  }
}
