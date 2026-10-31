import type { PayoutStatus } from "@mini-payments/shared";

export const PAYOUT_STATUS_LABEL: Record<PayoutStatus, string> = {
  pending_approval: "Pending approval",
  approved: "Approved",
  processing: "Processing",
  paid: "Paid",
  failed: "Failed",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const PAYOUT_STATUS_STYLE: Record<PayoutStatus, string> = {
  pending_approval: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  approved: "bg-sky-50 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  processing: "bg-indigo-50 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  paid: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300",
  rejected: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  cancelled: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

type Failure = { status: number; code: string; retryAfter?: number };

/** One clear sentence per failure the pay-out screens can hit. */
export function payoutErrorMessage({ status, code, retryAfter }: Failure): string {
  switch (code) {
    // 409
    case "version_conflict":
      return "This pay-out changed since you opened it. The latest version is shown now: check it and try again.";
    case "invalid_transition":
      return "This pay-out has already moved on (for example it was decided or cancelled), so that action no longer applies.";
    case "insufficient_funds":
      return "There isn't enough available balance in this currency to approve this pay-out.";
    case "idempotency_key_in_progress":
      return "This pay-out is still being created. Wait a moment and try again.";
    // 422
    case "idempotency_key_reused":
      return "This request was already sent with different details, so it can't be resubmitted. Start a new pay-out instead.";
    // 403
    case "self_approval_forbidden":
      return "You can't approve a pay-out you created. Another admin has to approve it.";
    case "self_rejection_forbidden":
      return "You can't reject a pay-out you created. Cancel it instead.";
    case "not_creator":
      return "Only the person who created this pay-out can cancel it.";
    case "forbidden":
      return "Your role doesn't allow this action.";
    case "payout_not_found":
      return "This pay-out doesn't exist in this organization.";
    case "network":
      return "Couldn't reach the server. Your request may or may not have gone through; trying again is safe.";
    case "service_unavailable":
      return "The service is temporarily unavailable. Try again in a few seconds.";
  }
  if (status === 429) {
    return retryAfter
      ? `Too many pay-outs in a short time. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`
      : "Too many pay-outs in a short time. Try again shortly.";
  }
  if (status === 409) return "This pay-out was changed by someone else. Reload and try again.";
  if (status === 422) return "This request can't be processed as sent. Start a new pay-out.";
  if (status === 400) return "Some details aren't valid. Check the form and try again.";
  return `Something went wrong (${status || "no response"}). Try again.`;
}
