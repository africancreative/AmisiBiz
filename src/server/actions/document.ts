"use server";

import { prisma } from "@/lib/db/prisma";
import { requireAuth } from "@/lib/auth/helpers";
import { authorizeTenant } from "@/server/auth/authorization";
import { PERMISSIONS } from "@/lib/auth/permissions";
import type { Prisma } from "@prisma/client";
import type { ActionResult } from "@/lib/errors";

function authzError<T = void>(error: unknown): ActionResult<T> {
  if (error instanceof Error && /not permitted|access/i.test(error.message)) {
    return { success: false, error: error.message };
  }
  return {
    success: false,
    error: "You are not permitted to perform this action.",
  };
}

interface DocumentQueryInput {
  tenantId: string;
  contactId?: string;
  search?: string;
  type?: string;
  status?: string;
  page: number;
  pageSize: number;
  sortBy: "createdAt" | "updatedAt" | "issuedAt" | "number" | "total";
  sortOrder: "asc" | "desc";
}

export async function getDocumentsAction(
  rawInput: unknown,
): Promise<ActionResult<{
  documents: Prisma.DocumentGetPayload<{}>[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}>> {
  const session = await requireAuth();

  const input = rawInput as DocumentQueryInput;
  const { tenantId, contactId, search, type, status, page, pageSize, sortBy, sortOrder } = input;

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DOCUMENTS_READ,
    );
  } catch (err) {
    return authzError(err);
  }

  const where: Prisma.DocumentWhereInput = {
    tenantId,
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
        totalPages: Math.ceil(total / pageSize),
      },
    };
  } catch (err) {
    console.error("[getDocumentsAction]", err);
    return { success: false, error: "Failed to load documents." };
  }
}

export async function getDocumentAction(
  documentId: string,
  tenantId: string,
): Promise<ActionResult<{ document: Prisma.DocumentGetPayload<{ include: { contact: true } }> | null }>> {
  const session = await requireAuth();

  try {
    await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.DOCUMENTS_READ,
    );
  } catch (err) {
    return authzError(err);
  }

  try {
    const document = await prisma.document.findFirst({
      where: { id: documentId, tenantId },
      include: {
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
      },
    });

    return { success: true, data: { document } };
  } catch (err) {
    console.error("[getDocumentAction]", err);
    return { success: false, error: "Failed to load document." };
  }
}