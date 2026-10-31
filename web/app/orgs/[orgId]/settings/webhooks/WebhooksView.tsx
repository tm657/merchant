"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useId, useState } from "react";
import { useSingleFlight } from "@/lib/useSingleFlight";
import { Dialog } from "@/components/Dialog";
import { useAnnounce } from "@/components/LiveRegion";
import { adminErrorMessage } from "@/lib/admin-messages";
import { bffGet, bffSend, type BffResult } from "@/lib/bff-client";
import { formatDateTime } from "@/lib/format";
import {
  createWebhookEndpointBodySchema,
  WEBHOOK_EVENT_TYPES,
  webhookEndpointListSchema,
  webhookEndpointResponseSchema,
  webhookSecretResponseSchema,
  type WebhookEndpoint,
  type WebhookEventType,
} from "@mini-payments/shared";
import { z } from "zod";

type Props = { orgId: string; initial: { items: WebhookEndpoint[] } | null };
type Failure = Extract<BffResult<unknown>, { ok: false }>;

const listKey = (orgId: string) => ["webhooks", orgId] as const;
const base = (orgId: string) => `/api/orgs/${encodeURIComponent(orgId)}/webhooks`;

export function WebhooksView({ orgId, initial }: Props) {
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  useState(() => {
    if (initial) queryClient.setQueryData(listKey(orgId), initial);
  });
  const query = useQuery({
    queryKey: listKey(orgId),
    queryFn: ({ signal }) => bffGet(base(orgId), webhookEndpointListSchema, signal),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: listKey(orgId) });

  type DialogState =
    | { kind: "create" }
    | { kind: "edit"; endpoint: WebhookEndpoint }
    | { kind: "rotate"; endpoint: WebhookEndpoint }
    | { kind: "delete"; endpoint: WebhookEndpoint }
    // The secret lives only here, in component state, until this dialog closes.
    | { kind: "secret"; endpoint: WebhookEndpoint; secret: string; rotated: boolean }
    | null;
  const [dialog, setDialog] = useState<DialogState>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const toggleOnce = useSingleFlight();

  const toggle = useMutation({
    mutationFn: (e: WebhookEndpoint) =>
      bffSend("PATCH", `${base(orgId)}/${e.id}`, { enabled: !e.enabled }, webhookEndpointResponseSchema),
    onSuccess: (res) => {
      void refresh();
      if (res.ok) {
        setRowError(null);
        announce(`Endpoint ${res.data.endpoint.enabled ? "enabled" : "disabled"}.`);
      } else setRowError(adminErrorMessage(res));
    },
  });

  const items = query.data?.items;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <button
          type="button"
          onClick={() => setDialog({ kind: "create" })}
          className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Add endpoint
        </button>
      </div>
      {rowError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {rowError}
        </p>
      )}

      {query.isError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          Could not load endpoints.{" "}
          <button type="button" onClick={() => void query.refetch()} className="font-medium underline">
            Retry
          </button>
        </p>
      ) : !items ? (
        <div className="h-24 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-900" role="status" aria-label="Loading endpoints" />
      ) : items.length === 0 ? (
        <p className="text-sm text-zinc-500">No endpoints yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((e) => (
            <li key={e.id} className="flex flex-col gap-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all font-mono text-sm font-medium">{e.url}</p>
                  {e.description && <p className="text-sm text-zinc-600 dark:text-zinc-400">{e.description}</p>}
                  <p className="mt-1 text-xs text-zinc-500">
                    {e.enabled ? "Enabled" : "Disabled"} · created {formatDateTime(e.createdAt)}
                    {e.secretRotatedAt && ` · secret rotated ${formatDateTime(e.secretRotatedAt)}`}
                    {e.previousSecretExpiresAt && ` · old secret also signs until ${formatDateTime(e.previousSecretExpiresAt)}`}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2 text-sm">
                  <Link href={`/orgs/${encodeURIComponent(orgId)}/settings/webhooks/${e.id}`} className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                    Deliveries
                  </Link>
                  <button type="button" onClick={() => setDialog({ kind: "edit", endpoint: e })} className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => void toggleOnce(() => toggle.mutateAsync(e))}
                    disabled={toggle.isPending}
                    aria-pressed={e.enabled}
                    className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
                  >
                    {e.enabled ? "Disable" : "Enable"}
                  </button>
                  <button type="button" onClick={() => setDialog({ kind: "rotate", endpoint: e })} className="rounded-md border border-zinc-300 px-3 py-1.5 font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
                    Rotate secret
                  </button>
                  <button type="button" onClick={() => setDialog({ kind: "delete", endpoint: e })} className="rounded-md border border-red-300 px-3 py-1.5 font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950">
                    Delete
                  </button>
                </div>
              </div>
              <ul aria-label="Events" className="flex flex-wrap gap-1">
                {e.events.map((ev) => (
                  <li key={ev} className="rounded-full bg-zinc-100 px-2 py-0.5 font-mono text-xs dark:bg-zinc-800">
                    {ev}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <EndpointDialog
        orgId={orgId}
        endpoint={dialog?.kind === "edit" ? dialog.endpoint : null}
        open={dialog?.kind === "create" || dialog?.kind === "edit"}
        onClose={() => setDialog(null)}
        onSaved={(result) => {
          void refresh();
          if ("secret" in result) setDialog({ kind: "secret", endpoint: result.endpoint, secret: result.secret, rotated: false });
          else {
            setDialog(null);
            announce("Endpoint saved.");
          }
        }}
      />
      <ConfirmAction
        open={dialog?.kind === "rotate"}
        title="Rotate signing secret?"
        description="A new secret is created now. The old one keeps signing alongside it for 24 hours, so you can update your receiver without dropping events."
        confirmLabel="Rotate secret"
        run={() =>
          dialog?.kind === "rotate"
            ? bffSend("POST", `${base(orgId)}/${dialog.endpoint.id}/rotate`, undefined, webhookSecretResponseSchema)
            : Promise.resolve({ ok: false, status: 0, code: "unknown_error" } as const)
        }
        onDone={(res) => {
          void refresh();
          if (res.ok && "secret" in res.data) setDialog({ kind: "secret", endpoint: res.data.endpoint, secret: res.data.secret, rotated: true });
        }}
        onClose={() => setDialog(null)}
      />
      <ConfirmAction
        open={dialog?.kind === "delete"}
        title="Delete endpoint?"
        description="It stops receiving events immediately, and its delivery history is removed. The audit log keeps a record."
        confirmLabel="Delete endpoint"
        danger
        run={() =>
          dialog?.kind === "delete"
            ? bffSend("DELETE", `${base(orgId)}/${dialog.endpoint.id}`, undefined, z.null())
            : Promise.resolve({ ok: false, status: 0, code: "unknown_error" } as const)
        }
        onDone={(res) => {
          void refresh();
          if (res.ok) {
            setDialog(null);
            announce("Endpoint deleted.");
          }
        }}
        onClose={() => setDialog(null)}
      />
      {dialog?.kind === "secret" && (
        <SecretDialog secret={dialog.secret} rotated={dialog.rotated} onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

/** Create (no `endpoint`) or edit. Creating returns the secret to the parent, once. */
function EndpointDialog({
  orgId,
  endpoint,
  open,
  onClose,
  onSaved,
}: {
  orgId: string;
  endpoint: WebhookEndpoint | null;
  open: boolean;
  onClose: () => void;
  onSaved: (result: { endpoint: WebhookEndpoint; secret: string } | { endpoint: WebhookEndpoint }) => void;
}) {
  const [pending, setPending] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} dismissible={!pending} title={endpoint ? "Edit endpoint" : "Add endpoint"}>
      <EndpointForm key={endpoint?.id ?? "new"} orgId={orgId} endpoint={endpoint} onPending={setPending} onCancel={onClose} onSaved={onSaved} />
    </Dialog>
  );
}

function EndpointForm({
  orgId,
  endpoint,
  onPending,
  onCancel,
  onSaved,
}: {
  orgId: string;
  endpoint: WebhookEndpoint | null;
  onPending: (p: boolean) => void;
  onCancel: () => void;
  onSaved: Parameters<typeof EndpointDialog>[0]["onSaved"];
}) {
  const [url, setUrl] = useState(endpoint?.url ?? "");
  const [description, setDescription] = useState(endpoint?.description ?? "");
  const [events, setEvents] = useState<WebhookEventType[]>(endpoint?.events ?? ["payout.paid", "payout.failed"]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<Failure | null>(null);
  const ids = { url: useId(), description: useId(), events: useId() };

  const save = useMutation({
    mutationFn: async (body: { url: string; description: string; events: WebhookEventType[] }) =>
      endpoint
        ? bffSend("PATCH", `${base(orgId)}/${endpoint.id}`, body, webhookEndpointResponseSchema)
        : bffSend("POST", base(orgId), { ...body, enabled: true }, webhookSecretResponseSchema),
    onMutate: () => onPending(true),
    onSettled: () => onPending(false),
    onSuccess: (res) => {
      if (res.ok) onSaved(res.data);
      else setFailure(res);
    },
  });

  const saveOnce = useSingleFlight();
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // The shared schema, as the API applies it (the API additionally checks the address).
    const parsed = createWebhookEndpointBodySchema.safeParse({ url: url.trim(), description, events });
    if (!parsed.success) {
      const next: Record<string, string> = {};
      for (const i of parsed.error.issues) next[String(i.path[0] ?? "form")] ??= i.message;
      setErrors(next);
      return;
    }
    setErrors({});
    setFailure(null);
    // Creating twice would make two endpoints: one request per submit, even for a double click.
    void saveOnce(() => save.mutateAsync({ url: parsed.data.url, description: parsed.data.description, events: parsed.data.events }));
  };

  const field = "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm aria-[invalid=true]:border-red-600 dark:border-zinc-700 dark:bg-zinc-900";
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      <label htmlFor={ids.url} className="flex flex-col gap-1 text-sm font-medium">
        URL
        <input
          id={ids.url}
          data-autofocus
          type="url"
          inputMode="url"
          placeholder="https://example.com/webhooks"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          aria-invalid={Boolean(errors.url)}
          aria-describedby={errors.url ? `${ids.url}-error` : `${ids.url}-hint`}
          className={`${field} font-mono`}
        />
        {errors.url ? (
          <span id={`${ids.url}-error`} className="text-xs text-red-700 dark:text-red-300">
            {errors.url}
          </span>
        ) : (
          <span id={`${ids.url}-hint`} className="text-xs font-normal text-zinc-500">
            HTTPS in production. Private and internal addresses are refused.
          </span>
        )}
      </label>
      <label htmlFor={ids.description} className="flex flex-col gap-1 text-sm font-medium">
        Description <span className="font-normal text-zinc-500">(optional)</span>
        <input id={ids.description} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} className={field} />
      </label>
      <fieldset aria-describedby={errors.events ? `${ids.events}-error` : undefined} className="flex flex-col gap-1">
        <legend className="mb-1 text-sm font-medium">Events</legend>
        {WEBHOOK_EVENT_TYPES.map((ev) => (
          <label key={ev} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={events.includes(ev)}
              onChange={(e) => setEvents((xs) => (e.target.checked ? [...xs, ev] : xs.filter((x) => x !== ev)))}
            />
            <span className="font-mono">{ev}</span>
          </label>
        ))}
        {errors.events && (
          <span id={`${ids.events}-error`} className="text-xs text-red-700 dark:text-red-300">
            {errors.events}
          </span>
        )}
      </fieldset>
      {failure && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {adminErrorMessage(failure)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={save.isPending} className="rounded-md px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800">
          Cancel
        </button>
        <button type="submit" disabled={save.isPending} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900">
          {save.isPending ? "Saving…" : endpoint ? "Save changes" : "Add endpoint"}
        </button>
      </div>
    </form>
  );
}

/** Shows the secret exactly once. Closing it is the last time anyone sees it. */
function SecretDialog({ secret, rotated, onClose }: { secret: string; rotated: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState<"yes" | "failed" | null>(null);
  const id = useId();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied("yes");
    } catch {
      setCopied("failed");
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={rotated ? "New signing secret" : "Endpoint added: signing secret"}
      description="Copy it now and store it somewhere safe. It won't be shown again."
    >
      <label htmlFor={id} className="flex flex-col gap-1 text-sm font-medium">
        Secret
        <input id={id} readOnly value={secret} onFocus={(e) => e.currentTarget.select()} className="rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900" />
      </label>
      {rotated && (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          For the next 24 hours requests carry two signatures (new and old secret), so update your receiver any time before then.
        </p>
      )}
      <p aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
        {copied === "yes" ? "Copied to the clipboard." : copied === "failed" ? "Couldn't copy: select the field and copy it yourself." : ""}
      </p>
      <div className="flex justify-end gap-2">
        <button type="button" data-autofocus onClick={() => void copy()} className="rounded-md border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
          Copy secret
        </button>
        <button type="button" onClick={onClose} className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
          I&apos;ve stored it
        </button>
      </div>
    </Dialog>
  );
}

function ConfirmAction<T>({
  open,
  title,
  description,
  confirmLabel,
  danger = false,
  run,
  onDone,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  danger?: boolean;
  run: () => Promise<BffResult<T>>;
  onDone: (res: BffResult<T>) => void;
  onClose: () => void;
}) {
  const mutation = useMutation({ mutationFn: run, onSuccess: onDone });
  const runOnce = useSingleFlight();
  const failure = mutation.data && !mutation.data.ok ? mutation.data : null;
  return (
    <Dialog
      open={open}
      onClose={() => {
        mutation.reset();
        onClose();
      }}
      dismissible={!mutation.isPending}
      title={title}
      description={description}
    >
      {failure && (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
          {adminErrorMessage(failure)}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={mutation.isPending} className="rounded-md px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800">
          Keep it
        </button>
        <button
          type="button"
          data-autofocus
          onClick={() => void runOnce(() => mutation.mutateAsync())}
          disabled={mutation.isPending}
          className={`rounded-md px-4 py-2 text-sm font-medium text-white disabled:opacity-50 ${danger ? "bg-red-700 hover:bg-red-800" : "bg-zinc-900 hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900"}`}
        >
          {mutation.isPending ? "Working…" : confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
