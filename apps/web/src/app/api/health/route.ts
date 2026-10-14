import { NextResponse } from "next/server";
import { pingDatabase } from "@amisibiz/database";

/**
 * GET /api/health
 * Health check endpoint for uptime monitoring and deployment probes.
 * Returns database connectivity status without exposing internal details.
 *
 * `pingDatabase()` is the only database call in the app that runs outside a
 * request scope: the scoped `prisma` client is fail-closed and refuses raw
 * statements without an authorized context, and a probe has no identity to
 * authorize. `SELECT 1` touches no table, so no policy is involved.
 */
export async function GET() {
  const reachable = await pingDatabase();

  if (reachable) {
    return NextResponse.json(
      {
        status: "ok",
        service: "amisibiz-api",
        timestamp: new Date().toISOString(),
      },
      { status: 200 },
    );
  }

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
