"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { useAnnounce } from "@/components/LiveRegion";
import { PayoutStatusBadge } from "@/components/PayoutStatusBadge";
import { BffError, bffGet, bffPostJson, type BffResult } from "@/lib/bff-client";
import { formatDateTime, formatMoney } from "@/lib/format";
import { PAYOUT_STATUS_LABEL, payoutErrorMessage } from "@/lib/payout-messages";
import {
  can,
  canTransition,
  payoutDetailSchema,
  payoutResponseSchema,
  rejectPayoutBodySchema,
  type Payout,
  type PayoutAction,
  type Role,
} from "@mini-payments/shared";

type Props = { orgId: string; payoutId: string; role: Role; currentUserId: string; onClose: () => void };

const DONE: Record<PayoutAction, string> = { approve: "approved", reject: "rejected", cancel: "cancelled" };

export function PayoutDetailPanel({ orgId, payoutId, role, currentUserId, onClose }: Props) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const detailKey = ["payout", orgId, payoutId] as const;

  const query = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) =>
      bffGet(`/api/orgs/${encodeURIComponent(orgId)}/payouts/${encodeURIComponent(payoutId)}`, payoutDetailSchema, signal),
  });

  // Opening a pay-out moves focus here, so keyboard and screen reader users land on it.
  useEffect(() => headingRef.current?.focus(), []);

  const [dialog, setDialog] = useState<PayoutAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ action, body }: { action: PayoutAction; body: object }): Promise<BffResult<{ payout: Payout }>> =>
      bffPostJson(
        `/api/orgs/${encodeURIComponent(orgId)}/payouts/${encodeURIComponent(payoutId)}/${action}`,
        body,
        payoutResponseSchema,
      ),
    onSuccess: (res, { action }) => {
      void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({ queryKey: ["payouts", orgId] });
      if (res.ok) {
        setDialog(null);
        setNotice(null);
        announce(`Pay-out ${DONE[action]}.`);
      } else if (res.status === 409 || res.status === 404) {
        // The pay-out moved on: close the dialog and explain next to the fresh data.
        setDialog(null);
        setNotice(payoutErrorMessage(res));
      }
    },
  });
  const failure = mutation.data && !mutation.data.ok ? mutation.data : null;

  const payout = query.data?.payout;
  const pending = payout?.status === "pending_approval";
  const mine = payout?.createdBy.id === currentUserId;
  // Never on your own pay-outs: the API refuses too, this only keeps the UI honest.
  const canApprove = Boolean(payout && pending && !mine && can(role, "payout:approve") && canTransition(payout.status, "approved"));
  const canReject = Boolean(payout && pending && !mine && can(role, "payout:reject"));
  const canCancel = Boolean(payout && pending && mine && can(role, "payout:create"));

  const decide = (action: PayoutAction, extra: object = {}) => {
    if (!payout) return;
    mutation.mutate({ action, body: { version: payout.version, ...extra } });
  };
  const openDialog = (action: PayoutAction) => {
    mutation.reset();
    setDialog(action);
  };

  return (
    <aside
      aria-labelledby={headingId}
      className="flex flex-col gap-4 self-start rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 id={headingId} ref={headingRef} tabIndex={-1} className="text-base font-semibold focus:outline-none">
          Pay-out details
        </h2>
        <button type="button" onClick={onClose} className="rounded-md px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
          Close<span className="sr-only"> pay-out details</span>
        </button>
      </div>

      {query.isError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {query.error instanceof BffError ? payoutErrorMessage(query.error) : "Could not load this pay-out."}
        </p>
      ) : !payout ? (
        <div className="h-40 animate-pulse rounded-md bg-zinc-100 dark:bg-zinc-900" aria-label="Loading pay-out" role="status" />
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-2xl font-semibold tabular-nums">{formatMoney(payout.amount, payout.currency)}</p>
            <div>
              <PayoutStatusBadge status={payout.status} />
            </div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-zinc-500">To</dt>
            <dd>
              {payout.beneficiaryName} <span className="text-zinc-500">•••• {payout.accountLast4}</span>
            </dd>
            <dt className="text-zinc-500">Reference</dt>
            <dd>{payout.reference || "—"}</dd>
            <dt className="text-zinc-500">Requested by</dt>
            <dd>{mine ? "You" : payout.createdBy.name}</dd>
            {payout.decidedBy && (
              <>
                <dt className="text-zinc-500">{payout.status === "rejected" ? "Rejected by" : "Approved by"}</dt>
                <dd>{payout.decidedBy.id === currentUserId ? "You" : payout.decidedBy.name}</dd>
              </>
            )}
            {payout.rejectReason && (
              <>
                <dt className="text-zinc-500">Reason</dt>
                <dd>{payout.rejectReason}</dd>
              </>
            )}
            {payout.failureReason && (
              <>
                <dt className="text-zinc-500">Failure</dt>
                <dd>{payout.failureReason}</dd>
              </>
            )}
          </dl>

          {notice && (
            <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {notice}
            </p>
          )}

          {pending && mine && can(role, "payout:approve") && (
            <p className="text-xs text-zinc-500">You created this pay-out, so another admin has to approve or reject it.</p>
          )}

          {(canApprove || canReject || canCancel) && (
            <div className="flex flex-wrap gap-2">
              {canApprove && (
                <button type="button" onClick={() => openDialog("approve")} className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800">
                  Approve
                </button>
              )}
              {canReject && (
                <button type="button" onClick={() => openDialog("reject")} className="rounded-md border border-red-300 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950">
                  Reject
                </button>
              )}
              {canCancel && (
                <button type="button" onClick={() => openDialog("cancel")} className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                  Cancel pay-out
                </button>
              )}
            </div>
          )}

          <section aria-label="Timeline">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Timeline</h3>
            <ol className="flex flex-col gap-3 border-l border-zinc-200 pl-4 text-sm dark:border-zinc-800">
              {query.data!.timeline.map((e) => (
                <li key={e.id} className="relative">
                  <span aria-hidden="true" className="absolute -left-[1.3rem] top-1.5 h-2 w-2 rounded-full bg-zinc-400" />
                  <p className="font-medium">
                    {e.fromStatus === e.toStatus ? "Retry scheduled" : PAYOUT_STATUS_LABEL[e.toStatus]}
                    <span className="font-normal text-zinc-500">
                      {" · "}
                      {/* Always the display name; "(you)" marks your own steps. */}
                      {e.actor ? `${e.actor.name}${e.actor.id === currentUserId ? " (you)" : ""}` : "System"}
                    </span>
                  </p>
                  <p className="text-xs text-zinc-500">
                    <time dateTime={e.at}>{formatDateTime(e.at)}</time>
                  </p>
                  {e.reason && <p className="mt-0.5 text-xs text-zinc-600 dark:text-zinc-400">{e.reason}</p>}
                </li>
              ))}
            </ol>
          </section>

          <ConfirmDialog
            open={dialog === "approve"}
            title="Approve pay-out?"
            description={`${formatMoney(payout.amount, payout.currency)} to ${payout.beneficiaryName} will be reserved from the available balance and sent.`}
            confirmLabel="Approve"
            pending={mutation.isPending}
            error={failure ? payoutErrorMessage(failure) : null}
            onConfirm={() => decide("approve")}
            onClose={() => setDialog(null)}
          />
          <ConfirmDialog
            open={dialog === "cancel"}
            title="Cancel pay-out?"
            description="It won't be sent, and it can't be reopened."
            confirmLabel="Cancel pay-out"
            pending={mutation.isPending}
            error={failure ? payoutErrorMessage(failure) : null}
            onConfirm={() => decide("cancel")}
            onClose={() => setDialog(null)}
          />
          <RejectDialog
            open={dialog === "reject"}
            pending={mutation.isPending}
            error={failure ? payoutErrorMessage(failure) : null}
            onReject={(reason) => decide("reject", { reason })}
            onClose={() => setDialog(null)}
          />
        </>
      )}
    </aside>
  );
}

type ConfirmProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
};

function ConfirmDialog({ open, title, description, confirmLabel, pending, error, onConfirm, onClose }: ConfirmProps) {
  return (
    <Dialog open={open} onClose={onClose} dismissible={!pending} title={title} description={description}>
      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={pending} className="rounded-md px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800">
          Keep it
        </button>
        <button
          type="button"
          data-autofocus
          onClick={onConfirm}
          disabled={pending}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {pending ? "Working…" : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

function RejectDialog({
  open,
  pending,
  error,
  onReject,
  onClose,
}: {
  open: boolean;
  pending: boolean;
  error: string | null;
  onReject: (reason: string) => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} dismissible={!pending} title="Reject pay-out?" description="The requester sees your reason.">
      <RejectForm pending={pending} error={error} onReject={onReject} onClose={onClose} />
    </Dialog>
  );
}

function RejectForm({ pending, error, onReject, onClose }: Omit<Parameters<typeof RejectDialog>[0], "open">) {
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const id = useId();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // Same rule as the API, from the shared schema.
    const parsed = rejectPayoutBodySchema.shape.reason.safeParse(reason);
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Give a reason");
      return;
    }
    setInvalid(null);
    onReject(parsed.data);
  };
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3">
      <label htmlFor={id} className="flex flex-col gap-1 text-sm font-medium">
        Reason
        <textarea
          id={id}
          data-autofocus
          rows={3}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={Boolean(invalid)}
          aria-describedby={invalid ? `${id}-error` : undefined}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm aria-[invalid=true]:border-red-600 dark:border-zinc-700 dark:bg-zinc-900"
        />
        {invalid && (
          <span id={`${id}-error`} className="text-xs text-red-700 dark:text-red-300">
            {invalid}
          </span>
        )}
      </label>
      {error && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={pending} className="rounded-md px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800">
          Keep it
        </button>
        <button type="submit" disabled={pending} className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-50">
          {pending ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </form>
  );
}
