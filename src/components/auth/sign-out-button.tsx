"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { logoutAction } from "@/server/actions/auth";

export function SignOutButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      className="btn btn-secondary"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        await logoutAction();
        // "/" re-resolves the locale and lands unauthenticated users on login.
        router.push("/");
        router.refresh();
      }}
    >
      {label}
    </button>
  );
}
