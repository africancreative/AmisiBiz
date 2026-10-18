"use server";

import { requireAuth } from "@/lib/auth/helpers";
import { PERMISSIONS } from "@amisibiz/auth";
import { authorizeTenant } from "@/server/auth/authorization";
import { fail, type ActionResult } from "@/lib/errors";
import { authorizationFailure, invalidInput } from "@/server/actions/_shared";
import { timelineQuerySchema } from "@/lib/validations/task";
import { getTimeline } from "@/server/services/activities/service";

/**
 * Timeline read action (AGENT 02 Phase 2A).
 *
 * There is exactly one export here and it is a READ. The timeline is
 * append-only and written solely through `appendActivity` inside the server
 * engines — exposing a write action would hand the browser the one capability
 * the single-writer design exists to deny (events would no longer be
 * traceable to a real mutation). Contact/lead/document ids are optional
 * filters; the tenant always comes from the authorized context.
 */
export async function getTimelineAction(rawInput: unknown): Promise<
  ActionResult<{
    events: Awaited<ReturnType<typeof getTimeline>>;
  }>
> {
  const session = await requireAuth();

  const parsed = timelineQuerySchema.safeParse(rawInput);
  if (!parsed.success) {
    return invalidInput(parsed.error, "Invalid timeline query.");
  }

  const { tenantId, contactId, leadId, documentId, limit, before } =
    parsed.data;

  let context;
  try {
    context = await authorizeTenant(
      session.user.id,
      tenantId,
      PERMISSIONS.ACTIVITIES_READ,
    );
  } catch (err) {
    return authorizationFailure(err, "getTimelineAction");
  }

  try {
    const events = await getTimeline(context, {
      // Conditional spreads keep absent filters out of the object entirely —
      // `TimelineFilter` is declared with `exactOptionalPropertyTypes`, where
      // an explicit `undefined` is a type error, not a "no filter".
      ...(contactId ? { contactId } : {}),
      ...(leadId ? { leadId } : {}),
      ...(documentId ? { documentId } : {}),
      limit,
      ...(before ? { before } : {}),
    });
    return { success: true, data: { events } };
  } catch (err) {
    console.error("[getTimelineAction]", err);
    return fail("Failed to load the timeline.", { code: "INTERNAL" });
  }
}
