import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session-user";
import { handleSyncPush } from "@/server/sync/push";
import { syncPushEnvelopeSchema } from "@/lib/validations/sync";

export async function POST(request: Request) {
  const json = await request.json();
  const parsed = syncPushEnvelopeSchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid payload", details: parsed.error.format() },
      { status: 400 }
    );
  }

  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  const result = await handleSyncPush({ _userId: user.id, tenantId: parsed.data.clientId, envelope: parsed.data });
  return NextResponse.json({ success: true, result });
}