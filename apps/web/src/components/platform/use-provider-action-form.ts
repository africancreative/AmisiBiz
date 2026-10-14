"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionResult } from "@/lib/errors";

/**
 * The submit loop every provider-console form shares: call the Server Action,
 * surface `error` and per-field messages, refresh the page on success, and keep
 * the button disabled while the write is in flight.
 *
 * It exists once because six panels would otherwise each re-implement the same
 * "did the platform actually accept this?" handling — and the one thing they must
 * all get identically right is never reporting success on a refusal.
 */
export function useProviderActionForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [succeeded, setSucceeded] = useState(false);

  async function run(
    action: () => Promise<ActionResult>,
    options: { keepOpen?: boolean } = {},
  ): Promise<boolean> {
    setPending(true);
    setError(null);
    setFieldErrors({});
    setSucceeded(false);

    const result = await action();

    setPending(false);

    if (!result.success) {
      setError(result.error);
      setFieldErrors(result.fieldErrors ?? {});
      return false;
    }

    setSucceeded(true);
    if (!options.keepOpen) setError(null);
    // Server components read through RLS-scoped queries, so the panel has to ask
    // for fresh data instead of guessing what the write changed.
    router.refresh();
    return true;
  }

  function fieldError(name: string): string | undefined {
    const messages = fieldErrors[name];
    return messages && messages.length > 0 ? messages[0] : undefined;
  }

  return { pending, error, succeeded, run, fieldError };
}
