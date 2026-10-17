import { NextResponse } from "next/server";
import { pingDatabase } from "@amisibiz/database";
import { getCapabilities } from "@/lib/capabilities";

export const dynamic = "force-dynamic";

/**
 * GET /api/health/ready
 *
 * Readiness probe. Reports whether required infrastructure is reachable and
 * which optional services are actually configured. It exposes only booleans —
 * never a secret, host, credential or error message — so it can be called by an
 * uptime service without leaking configuration.
 */
export async function GET() {
  const databaseReachable = await pingDatabase();
  const capabilities = getCapabilities();

  const ready = databaseReachable;

  return NextResponse.json(
    {
      ready,
      databaseReachable,
      services: {
        email: capabilities.email.configured,
        objectStorage: capabilities.objectStorage.configured,
        rateLimit: capabilities.rateLimit.configured,
        pdf: capabilities.pdf.configured,
      },
      timestamp: new Date().toISOString(),
    },
    { status: ready ? 200 : 503 },
  );
}
