"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { bffPost, safeNextPath } from "@/lib/bff-client";
import { buttonClass, inputClass, labelClass, retryText } from "./AuthShell";

export function LoginForm() {
  const id = useId();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const notice = params.get("registered")
    ? "If that email wasn't registered yet, your account is ready. Sign in below."
    : params.get("expired")
      ? "Your session has ended. Please sign in again."
      : null;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const res = await bffPost("/api/auth/login", {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    }).catch(() => ({ ok: false, status: 0, code: "network", retryAfter: undefined }));

    if (res.ok) {
      // A new user: nothing cached for the previous one may survive.
      queryClient.clear();
      // Full page load, so no router cache or hidden page from before survives either.
      window.location.assign(safeNextPath(params.get("next")));
      return;
    }
    setPending(false);
    setError(
      res.status === 429
        ? retryText(res.retryAfter)
        : res.status === 401
          ? "Incorrect email or password."
          : "Something went wrong. Please try again.",
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
      {notice && (
        <p role="status" className="rounded-md bg-zinc-100 p-3 text-sm dark:bg-zinc-900">
          {notice}
        </p>
      )}
      <label className={labelClass} htmlFor={`${id}-email`}>
        Email
        <input id={`${id}-email`} name="email" type="email" autoComplete="username" required className={inputClass} />
      </label>
      <label className={labelClass} htmlFor={`${id}-password`}>
        Password
        <input
          id={`${id}-password`}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className={inputClass}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        No account?{" "}
        <Link href="/register" className="font-medium underline">
          Create one
        </Link>
      </p>
    </form>
  );
}
