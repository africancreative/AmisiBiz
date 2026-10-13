import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";

/**
 * GET /api/health
 * Health check endpoint for uptime monitoring and deployment probes.
 * Returns database connectivity status without exposing internal details.
 */
export async function GET() {
  try {
    // Minimal DB ping — just check connectivity
    await prisma.$queryRaw`SELECT 1`;

    return NextResponse.json(
      {
        status: "ok",
        service: "amisibiz-api",
        timestamp: new Date().toISOString(),
      },
      { status: 200 },
    );
  } catch {
    // Do NOT expose DB error details
    return NextResponse.json(
      {
        status: "degraded",
        service: "amisibiz-api",
        timestamp: new Date().toISOString(),
      },
      { status: 503 },
    );
  }
}
