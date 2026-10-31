import type { AuditAction, ExportStatus, WebhookDeliveryStatus } from "@mini-payments/shared";

export const AUDIT_ACTION_LABEL: Record<AuditAction, string> = {
  "auth.login.succeeded": "Signed in",
  "auth.login.failed": "Sign-in failed",
  "auth.logout": "Signed out",
  "payout.created": "Pay-out created",
  "payout.approved": "Pay-out approved",
  "payout.rejected": "Pay-out rejected",
  "payout.cancelled": "Pay-out cancelled",
  "payout.processing": "Pay-out processing",
  "payout.paid": "Pay-out paid",
  "payout.failed": "Pay-out failed",
  "webhook.endpoint.created": "Webhook endpoint created",
  "webhook.endpoint.updated": "Webhook endpoint updated",
  "webhook.endpoint.secret_rotated": "Webhook secret rotated",
  "webhook.endpoint.deleted": "Webhook endpoint deleted",
  "webhook.delivery.redelivered": "Webhook redelivered",
  "audit.exported": "Audit log exported",
  "report.export.requested": "Transactions export requested",
  "report.export.downloaded": "Transactions export downloaded",
};

export const EXPORT_STATUS_LABEL: Record<ExportStatus, string> = {
  queued: "Queued",
  running: "Running",
  completed: "Ready",
  failed: "Failed",
  expired: "Expired",
};

export function exportErrorMessage({ status, code, retryAfter }: { status: number; code: string; retryAfter?: number }): string {
  switch (code) {
    case "too_many_exports":
      return "This organization already has 20 exports waiting. Let some finish first.";
    case "export_expired":
      return "This export has expired (downloads last 24 hours). Export again.";
    case "export_not_ready":
      return "This export isn't finished yet.";
    case "export_not_found":
      return "This export doesn't exist.";
    case "forbidden":
      return "Your role can't export reports.";
    case "network":
      return "Couldn't reach the server. Try again.";
  }
  if (status === 429) return `Too many requests. Try again${retryAfter ? ` in ${retryAfter} s` : " shortly"}.`;
  return `Something went wrong (${status || "no response"}). Try again.`;
}

export const DELIVERY_STATUS_LABEL: Record<WebhookDeliveryStatus, string> = {
  pending: "Pending",
  delivering: "Delivering",
  succeeded: "Delivered",
  dead: "Failed permanently",
};

export const DELIVERY_STATUS_STYLE: Record<WebhookDeliveryStatus, string> = {
  pending: "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  delivering: "bg-indigo-50 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  succeeded: "bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  dead: "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-300",
};

type Failure = { status: number; code: string; message?: string; retryAfter?: number };

/** One clear sentence per failure on the admin screens. */
export function adminErrorMessage({ status, code, message }: Failure): string {
  switch (code) {
    case "webhook_url_not_allowed":
      return `This URL can't be used: ${message ?? "it points at a private or blocked address"}.`;
    case "webhook_endpoint_not_found":
      return "This endpoint no longer exists.";
    case "webhook_delivery_not_found":
      return "This delivery no longer exists.";
    case "webhook_endpoint_disabled":
      return "Enable the endpoint before redelivering.";
    case "forbidden":
      return "Only admins can do this.";
    case "network":
      return "Couldn't reach the server. Try again.";
    case "invalid_cursor":
      return "This page link is no longer valid.";
  }
  if (status === 400) return "Some details aren't valid. Check the form and try again.";
  return `Something went wrong (${status || "no response"}). Try again.`;
}
