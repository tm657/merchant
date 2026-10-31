import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DataTable, type Column } from "@/components/DataTable";

type Row = { id: string; name: string; amount: number };
type Key = "name" | "amount";

const columns: Column<Row, Key>[] = [
  { id: "name", header: "Name", sortKey: "name", cell: (r) => r.name },
  { id: "note", header: "Note", cell: () => "—" },
  { id: "amount", header: "Amount", sortKey: "amount", align: "right", cell: (r) => r.amount },
];
const rows: Row[] = [
  { id: "a", name: "Alpha", amount: 10 },
  { id: "b", name: "Beta", amount: 20 },
];

function setup(props: Partial<Parameters<typeof DataTable<Row, Key>>[0]> = {}) {
  const onSortChange = vi.fn();
  render(
    <DataTable<Row, Key>
      columns={columns}
      rows={rows}
      sort={{ key: "amount", dir: "desc" }}
      onSortChange={onSortChange}
      getRowId={(r) => r.id}
      renderEmpty={() => <p>Nothing here</p>}
      caption="Things"
      {...props}
    />,
  );
  return { onSortChange };
}

describe("DataTable", () => {
  it("renders one row per item, in the order given (it never sorts by itself)", () => {
    setup();
    const body = screen.getAllByRole("rowgroup")[1]!;
    expect(within(body).getAllByRole("row").map((r) => r.textContent)).toEqual(["Alpha—10", "Beta—20"]);
    expect(screen.getByRole("table", { name: "Things" })).toBeTruthy();
  });

  it("marks the sorted column with aria-sort and the others as none", () => {
    setup();
    expect(screen.getByRole("columnheader", { name: /Amount/ }).getAttribute("aria-sort")).toBe("descending");
    expect(screen.getByRole("columnheader", { name: /Name/ }).getAttribute("aria-sort")).toBe("none");
    // Unsortable columns have no sort button and no aria-sort.
    const note = screen.getByRole("columnheader", { name: "Note" });
    expect(note.getAttribute("aria-sort")).toBeNull();
    expect(within(note).queryByRole("button")).toBeNull();
  });

  it("asks for the next sort: active desc → asc, another column → desc", async () => {
    const { onSortChange } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Amount/ }));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "amount", dir: "asc" });
    await userEvent.click(screen.getByRole("button", { name: /Name/ }));
    expect(onSortChange).toHaveBeenLastCalledWith({ key: "name", dir: "desc" });
  });

  it("shows the empty state across all columns, and aria-busy while loading", () => {
    setup({ rows: [], busy: true });
    const cell = screen.getByText("Nothing here").closest("td")!;
    expect(cell.getAttribute("colspan")).toBe("3");
    expect(screen.getByRole("table").getAttribute("aria-busy")).toBe("true");
  });
});
