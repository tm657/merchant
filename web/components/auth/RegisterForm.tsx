"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { bffPost } from "@/lib/bff-client";
import { PASSWORD_MIN_LENGTH } from "@mini-payments/shared";
import { buttonClass, inputClass, labelClass, retryText } from "./AuthShell";

export function RegisterForm() {
  const id = useId();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const res = await bffPost("/api/auth/register", {
      name: String(form.get("name") ?? ""),
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    }).catch(() => ({ ok: false, status: 0, code: "network", retryAfter: undefined }));

    if (res.ok) {
      // Same outcome whether or not the email already had an account.
      router.push("/login?registered=1");
      return;
    }
    setPending(false);
    setError(
      res.status === 429
        ? retryText(res.retryAfter)
        : res.status === 400
          ? `Check the form: a valid email, a name, and a password of at least ${PASSWORD_MIN_LENGTH} characters.`
          : "Something went wrong. Please try again.",
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <label className={labelClass} htmlFor={`${id}-name`}>
        Name
        <input id={`${id}-name`} name="name" autoComplete="name" required maxLength={100} className={inputClass} />
      </label>
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
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={256}
          aria-describedby={`${id}-password-hint`}
          className={inputClass}
        />
        <span id={`${id}-password-hint`} className="text-xs font-normal text-zinc-500">
          At least {PASSWORD_MIN_LENGTH} characters.
        </span>
      </label>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      <button type="submit" disabled={pending} className={buttonClass}>
        {pending ? "Creating account…" : "Create account"}
      </button>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Already have an account?{" "}
        <Link href="/login" className="font-medium underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}
