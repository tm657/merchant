import Link from "next/link";

export function AccessDenied() {
  return (
    <div role="alert" className="flex flex-col items-start gap-2 rounded-lg border border-zinc-200 p-6 dark:border-zinc-800">
      <h2 className="text-lg font-semibold">No access</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">You are not a member of this organization.</p>
      <Link href="/" className="text-sm font-medium underline">
        Go to your organizations
      </Link>
    </div>
  );
}
