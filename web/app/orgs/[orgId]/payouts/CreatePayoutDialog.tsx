"use client";

import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useSingleFlight } from "@/lib/useSingleFlight";
import { Dialog } from "@/components/Dialog";
import { bffPostJson, type BffResult } from "@/lib/bff-client";
import { formatMoney } from "@/lib/format";
import { payoutErrorMessage } from "@/lib/payout-messages";
import {
  createPayoutBodySchema,
  CURRENCIES,
  CURRENCY_EXPONENT,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  parseMoneyInput,
  payoutResponseSchema,
  type CreatePayoutBody,
  type Currency,
  type Payout,
} from "@mini-payments/shared";

type Props = {
  orgId: string;
  open: boolean;
  onClose: () => void;
  onCreated: (payout: Payout, replayed: boolean) => void;
};

export function CreatePayoutDialog({ orgId, open, onClose, onCreated }: Props) {
  // Changing this remounts the form: a fresh form and a fresh idempotency key.
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!pending}
      title="New pay-out"
      description="An admin other than you approves it before any money moves."
    >
      <CreatePayoutForm
        key={attempt}
        orgId={orgId}
        onCancel={onClose}
        onCreated={onCreated}
        onPendingChange={setPending}
        onStartOver={() => setAttempt((n) => n + 1)}
      />
    </Dialog>
  );
}

type Fields = { amount: string; currency: Currency; beneficiaryName: string; accountNumber: string; reference: string };
type FieldErrors = Partial<Record<keyof Fields, string>>;

function validate(fields: Fields): { body: CreatePayoutBody } | { errors: FieldErrors } {
  const errors: FieldErrors = {};
  const money = parseMoneyInput(fields.amount, fields.currency);
  if (!money.ok) errors.amount = money.error;
  const parsed = createPayoutBodySchema.safeParse({ ...fields, amount: money.ok ? money.amount : 1 });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof Fields;
      errors[key] ??= issue.message;
    }
  }
  return parsed.success && money.ok ? { body: { ...parsed.data, amount: money.amount } } : { errors };
}

function CreatePayoutForm({
  orgId,
  onCancel,
  onCreated,
  onPendingChange,
  onStartOver,
}: {
  orgId: string;
  onCancel: () => void;
  onCreated: Props["onCreated"];
  onPendingChange: (pending: boolean) => void;
  onStartOver: () => void;
}) {
  // Generated when the form opens and reused for every retry of this pay-out, so a retry
  // after a lost response can never create a second one.
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [fields, setFields] = useState<Fields>({ amount: "", currency: "USD", beneficiaryName: "", accountNumber: "", reference: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [review, setReview] = useState<CreatePayoutBody | null>(null);
  const ids = { amount: useId(), currency: useId(), name: useId(), account: useId(), reference: useId(), error: useId() };

  // Switching between the form and the review step replaces the focused button, so move
  // focus to the step's main control instead of letting it fall to the page.
  const stepRef = useRef<HTMLDivElement>(null);
  const inReview = review !== null;
  useEffect(() => {
    stepRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [inReview]);

  const mutation = useMutation({
    mutationFn: (body: CreatePayoutBody): Promise<BffResult<{ payout: Payout }>> =>
      bffPostJson(`/api/orgs/${encodeURIComponent(orgId)}/payouts`, body, payoutResponseSchema, {
        [IDEMPOTENCY_KEY_HEADER]: idempotencyKey,
      }),
    onMutate: () => onPendingChange(true),
    onSettled: () => onPendingChange(false),
    onSuccess: (res) => {
      if (res.ok) onCreated(res.data.payout, res.headers.get(IDEMPOTENT_REPLAYED_HEADER) === "true");
    },
  });
  const failure = mutation.data && !mutation.data.ok ? mutation.data : null;

  // isPending (and so the disabled button) only takes effect after a re-render; two clicks
  // in the same tick would both get through. This blocks the second one at once.
  const singleFlight = useSingleFlight();
  const submit = (body: CreatePayoutBody) => void singleFlight(() => mutation.mutateAsync(body));
  // 422: this key belongs to other details now. Only a new key (a new form) can continue.
  const mustStartOver = failure?.status === 422;

  const set = (key: keyof Fields) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setFields((f) => ({ ...f, [key]: e.target.value }));

  const onReview = (e: React.FormEvent) => {
    e.preventDefault();
    const result = validate(fields);
    if ("errors" in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    mutation.reset();
    setReview(result.body);
  };

  if (review) {
    return (
      <div ref={stepRef} className="flex flex-col gap-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">Check the details</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-zinc-500">Amount</dt>
          <dd className="font-semibold tabular-nums">{formatMoney(review.amount, review.currency)}</dd>
          <dt className="text-zinc-500">Beneficiary</dt>
          <dd>{review.beneficiaryName}</dd>
          <dt className="text-zinc-500">Account</dt>
          <dd className="font-mono">{review.accountNumber}</dd>
          <dt className="text-zinc-500">Reference</dt>
          <dd>{review.reference || "—"}</dd>
        </dl>

        {failure && (
          <p id={ids.error} role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            {payoutErrorMessage(failure)}
          </p>
        )}

        <div className="flex justify-end gap-2">
          {mustStartOver ? (
            <button type="button" onClick={onStartOver} data-autofocus className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white dark:bg-zinc-100 dark:text-zinc-900">
              Start a new pay-out
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setReview(null)}
                disabled={mutation.isPending}
                className="rounded-md px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800"
              >
                Back
              </button>
              <button
                type="button"
                data-autofocus
                onClick={() => submit(review)}
                disabled={mutation.isPending}
                aria-describedby={failure ? ids.error : undefined}
                className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
              >
                {mutation.isPending ? "Creating…" : failure ? "Try again" : "Create pay-out"}
              </button>
            </>
          )}
        </div>
        <p aria-live="polite" className="sr-only">
          {mutation.isPending ? "Creating pay-out…" : ""}
        </p>
      </div>
    );
  }

  const exponent = CURRENCY_EXPONENT[fields.currency];
  const fieldClass =
    "rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm aria-[invalid=true]:border-red-600 dark:border-zinc-700 dark:bg-zinc-900";
  const errorText = (key: keyof Fields, id: string) =>
    errors[key] && (
      <span id={`${id}-error`} className="text-xs text-red-700 dark:text-red-300">
        {errors[key]}
      </span>
    );
  const described = (key: keyof Fields, id: string) => (errors[key] ? `${id}-error` : undefined);

  return (
    <div ref={stepRef}>
    <form onSubmit={onReview} noValidate className="flex flex-col gap-4">
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <label htmlFor={ids.amount} className="flex flex-col gap-1 text-sm font-medium">
          Amount
          <input
            id={ids.amount}
            data-autofocus
            inputMode={exponent === 0 ? "numeric" : "decimal"}
            autoComplete="off"
            placeholder={exponent === 0 ? "15,000" : "1,234.56"}
            value={fields.amount}
            onChange={set("amount")}
            aria-invalid={Boolean(errors.amount)}
            aria-describedby={described("amount", ids.amount)}
            className={fieldClass}
          />
          {errorText("amount", ids.amount)}
        </label>
        <label htmlFor={ids.currency} className="flex flex-col gap-1 text-sm font-medium">
          Currency
          <select id={ids.currency} value={fields.currency} onChange={set("currency")} className={fieldClass}>
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <label htmlFor={ids.name} className="flex flex-col gap-1 text-sm font-medium">
        Beneficiary name
        <input
          id={ids.name}
          value={fields.beneficiaryName}
          onChange={set("beneficiaryName")}
          aria-invalid={Boolean(errors.beneficiaryName)}
          aria-describedby={described("beneficiaryName", ids.name)}
          className={fieldClass}
        />
        {errorText("beneficiaryName", ids.name)}
      </label>
      <label htmlFor={ids.account} className="flex flex-col gap-1 text-sm font-medium">
        Account number
        <input
          id={ids.account}
          autoComplete="off"
          spellCheck={false}
          value={fields.accountNumber}
          onChange={set("accountNumber")}
          aria-invalid={Boolean(errors.accountNumber)}
          aria-describedby={described("accountNumber", ids.account)}
          className={`${fieldClass} font-mono`}
        />
        {errorText("accountNumber", ids.account)}
      </label>
      <label htmlFor={ids.reference} className="flex flex-col gap-1 text-sm font-medium">
        Reference <span className="font-normal text-zinc-500">(optional)</span>
        <input
          id={ids.reference}
          value={fields.reference}
          onChange={set("reference")}
          aria-invalid={Boolean(errors.reference)}
          aria-describedby={described("reference", ids.reference)}
          className={fieldClass}
        />
        {errorText("reference", ids.reference)}
      </label>
      {Object.keys(errors).length > 0 && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          Fix the highlighted fields to continue.
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md px-4 py-2 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
          Cancel
        </button>
        <button type="submit" className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900">
          Review
        </button>
      </div>
    </form>
    </div>
  );
}
