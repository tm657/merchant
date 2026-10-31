import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { TransactionsView } from "@/app/orgs/[orgId]/transactions/TransactionsView";
import { OrgEventsProvider } from "@/components/OrgEvents";
import type { Transaction } from "@mini-payments/shared";
import { renderWithQuery } from "./render";
import { server } from "./setup";

const tx = (id: string): Transaction => ({
  id,
  type: "payin",
  merchant: `Merchant ${id}`,
  amount: 1000,
  currency: "USD",
  status: "success",
  createdAt: "2026-03-01T10:00:00.000Z",
  payoutId: null,
});

/** Pages p1 → p2 → p3 (cursor "c1" leads to p2, "c2" to p3). Records every request's query. */
function pagedApi() {
  const requests: URLSearchParams[] = [];
  server.use(
    http.get("*/api/orgs/org_1/transactions", ({ request }) => {
      const q = new URL(request.url).searchParams;
      requests.push(q);
      const cursor = q.get("cursor");
      const page = cursor === "c1" ? 2 : cursor === "c2" ? 3 : 1;
      const prefix = q.get("status") ?? "all";
      return HttpResponse.json({
        items: [tx(`${prefix}-p${page}`)],
        nextCursor: page < 3 ? `c${page}` : null,
      });
    }),
  );
  return requests;
}

function renderView() {
  return renderWithQuery(
    <OrgEventsProvider orgId="org_1">
      <TransactionsView orgId="org_1" canExport={false} initialPage={null} initialFiltersKey="" />
    </OrgEventsProvider>,
  );
}

describe("TransactionsView cursor stack", () => {
  it("pages forward and back with cursors, and a filter change starts again at page 1", async () => {
    const requests = pagedApi();
    renderView();
    const user = userEvent.setup();

    await screen.findByText("Merchant all-p1");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Merchant all-p2");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Merchant all-p3");
    expect(screen.getByText(/^Page 3/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);
    expect(requests.map((q) => q.get("cursor"))).toEqual([null, "c1", "c2"]);

    // Back one page comes from the stack (cached), not a new cursor.
    await user.click(screen.getByRole("button", { name: "Prev" }));
    await screen.findByText("Merchant all-p2");
    expect(screen.getByText(/^Page 2/)).toBeTruthy();

    // A new filter: the old cursors belong to the old filter, so it's page 1 again.
    await user.selectOptions(screen.getByLabelText("Status"), "success");
    await screen.findByText("Merchant success-p1");
    expect(screen.getByText(/^Page 1/)).toBeTruthy();
    const last = requests.at(-1)!;
    expect(last.get("status")).toBe("success");
    expect(last.get("cursor")).toBeNull();
    expect(window.location.search).toBe("?status=success");
    expect((screen.getByRole("button", { name: "Prev" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("goes back to the earlier filter's page 1 on browser back, not to its old page", async () => {
    pagedApi();
    renderView();
    const user = userEvent.setup();
    await screen.findByText("Merchant all-p1");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Merchant all-p2");
    await user.selectOptions(screen.getByLabelText("Status"), "success");
    await screen.findByText("Merchant success-p1");

    window.history.back();
    await waitFor(() => expect(window.location.search).toBe(""));
    await screen.findByText("Merchant all-p1");
    expect(screen.getByText(/^Page 1/)).toBeTruthy();
  });
});
