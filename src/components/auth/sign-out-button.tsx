"use client";

import { signOut } from "next-auth/react";
import { useState } from "react";

export function SignOutButton({ label }: { label: string }) {
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      className="btn btn-secondary"
      disabled={pending}
      onClick={() => {
        setPending(true);
        void signOut({ callbackUrl: "/" });
      }}
    >
      {label}
    </button>
  );
}
