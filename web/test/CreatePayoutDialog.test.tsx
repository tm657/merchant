import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { CreatePayoutDialog } from "@/app/orgs/[orgId]/payouts/CreatePayoutDialog";
import type { Payout } from "@mini-payments/shared";
import { renderWithQuery } from "./render";
import { server } from "./setup";

const payout: Payout = {
  id: "po_1",
  amount: 123456,
  currency: "USD",
  status: "pending_approval",
  version: 1,
  beneficiaryName: "Acme Ltd",
  accountLast4: "7890",
  reference: "",
  createdBy: { id: "u1", name: "Max" },
  decidedBy: null,
  rejectReason: null,
  failureReason: null,
  createdAt: "2026-03-01T10:00:00.000Z",
  updatedAt: "2026-03-01T10:00:00.000Z",
};

type Seen = { key: string | null; body: unknown };

/** Answers with `responses` in order (the last repeats), after `gate` resolves; records each request. */
function payoutsApi(responses: (() => Response)[], gate: () => Promise<void> = async () => {}) {
  const seen: Seen[] = [];
  server.use(
    http.post("*/api/orgs/org_1/payouts", async ({ request }) => {
      seen.push({ key: request.headers.get("idempotency-key"), body: await request.json() });
      await gate();
      return responses[Math.min(seen.length - 1, responses.length - 1)]!();
    }),
  );
  return seen;
}

const created = () => HttpResponse.json({ payout }, { status: 201 });

function renderDialog(onCreated = vi.fn()) {
  const view = renderWithQuery(<CreatePayoutDialog orgId="org_1" open onClose={() => {}} onCreated={onCreated} />);
  return { ...view, onCreated };
}

async function fillAndReview(user = userEvent.setup()) {
  await user.type(screen.getByLabelText("Amount"), "1,234.56");
  await user.type(screen.getByLabelText("Beneficiary name"), "Acme Ltd");
  await user.type(screen.getByLabelText("Account number"), "gb12 3456 7890");
  await user.click(screen.getByRole("button", { name: "Review" }));
  await screen.findByText("Check the details");
  return user;
}

describe("CreatePayoutDialog", () => {
  it("validates with the shared rules before anything is sent", async () => {
    const seen = payoutsApi([created]);
    renderDialog();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Amount"), "1.234");
    await user.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("USD amounts have at most 2 decimals")).toBeTruthy();
    expect(screen.getByText("Enter the beneficiary's name")).toBeTruthy();
    // With an error shown, the label reads "Amount" plus the message.
    expect(screen.getByLabelText(/^Amount/).getAttribute("aria-invalid")).toBe("true");
    expect(seen).toHaveLength(0);
  });

  it("shows a confirm step with integer minor units sent, and creates on confirm", async () => {
    const seen = payoutsApi([created]);
    const { onCreated } = renderDialog();
    const user = await fillAndReview();
    expect(screen.getByText("$1,234.56")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Create pay-out" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(payout, false));
    expect(seen[0]!.body).toEqual({ amount: 123456, currency: "USD", beneficiaryName: "Acme Ltd", accountNumber: "GB1234567890", reference: "" });
    expect(seen[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reuses the same Idempotency-Key when retrying after a network failure", async () => {
    const seen = payoutsApi([() => HttpResponse.error(), created]);
    const { onCreated } = renderDialog();
    const user = await fillAndReview();
    await user.click(screen.getByRole("button", { name: "Create pay-out" }));
    await screen.findByText(/Couldn't reach the server/);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.key).toBe(seen[0]!.key);
  });

  it("sends one request for a double click, and disables submit while pending", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen = payoutsApi([created], () => gate);
    const { onCreated } = renderDialog();
    await fillAndReview();
    const submit = screen.getByRole("button", { name: "Create pay-out" });
    // Two clicks in the same tick, before React can re-render the button as disabled.
    act(() => {
      fireEvent.click(submit);
      fireEvent.click(submit);
    });
    await screen.findByRole("button", { name: "Creating…" });
    expect((screen.getByRole("button", { name: "Creating…" }) as HTMLButtonElement).disabled).toBe(true);
    // Escape does nothing while the request is in flight.
    fireEvent.keyDown(screen.getByRole("button", { name: "Creating…" }), { key: "Escape" });
    release();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(seen).toHaveLength(1);
  });

  it("starts over with a new key after a 422, and a reopened dialog gets a new key too", async () => {
    const seen = payoutsApi([() => HttpResponse.json({ error: "idempotency_key_reused" }, { status: 422 }), created]);
    const { rerender, client } = renderDialog();
    const user = await fillAndReview();
    await user.click(screen.getByRole("button", { name: "Create pay-out" }));
    await screen.findByText(/already sent with different details/);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Start a new pay-out" }));
    await fillAndReview(user);
    await user.click(screen.getByRole("button", { name: "Create pay-out" }));
    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[1]!.key).not.toBe(seen[0]!.key);

    // Close and reopen: a fresh form and a fresh key.
    const { QueryClientProvider } = await import("@tanstack/react-query");
    const tree = (open: boolean) => (
      <QueryClientProvider client={client}>
        <CreatePayoutDialog orgId="org_1" open={open} onClose={() => {}} onCreated={() => {}} />
      </QueryClientProvider>
    );
    rerender(tree(false));
    rerender(tree(true));
    await fillAndReview(user);
    await user.click(screen.getByRole("button", { name: "Create pay-out" }));
    await waitFor(() => expect(seen).toHaveLength(3));
    expect(new Set(seen.map((s) => s.key)).size).toBe(3);
  });
});
