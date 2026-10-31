import { expect, test } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { RECEIVER_URL, ROOT, stack } from "../stack";
import { approve, createPayout, login, userPage } from "./support";

/** The real demo receiver (api/scripts/webhook-receiver.ts), verifying with `secret`. */
function startReceiver(secret: string) {
  const child = spawn("npm", ["run", "webhook-receiver", "--silent", "-w", "api"], {
    cwd: ROOT,
    env: { ...process.env, WEBHOOK_SECRET: secret, RECEIVER_PORT: String(stack.receiverPort) },
    detached: true,
  });
  let output = "";
  child.stdout!.on("data", (d: Buffer) => (output += d.toString()));
  child.stderr!.on("data", (d: Buffer) => (output += d.toString()));
  return {
    child,
    output: () => output,
    stop: () => {
      // The whole group: npm, tsx and node.
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    },
  };
}

test("a signed webhook arrives at the receiver and verifies", async ({ page, browser }) => {
  let receiver: { child: ChildProcess; output: () => string; stop: () => void } | undefined;
  try {
    await login(page, "alice");
    await page.goto("/orgs/org_1/settings/webhooks");
    await page.getByRole("button", { name: "Add endpoint" }).click();
    const dialog = page.getByRole("dialog", { name: "Add endpoint" });
    await dialog.getByLabel("URL").fill(RECEIVER_URL);
    await dialog.getByRole("button", { name: "Add endpoint" }).click();

    // Shown once: read it now.
    const secretDialog = page.getByRole("dialog", { name: /signing secret/ });
    const secret = await secretDialog.getByLabel("Secret").inputValue();
    expect(secret).toMatch(/^whsec_/);
    await secretDialog.getByRole("button", { name: "I've stored it" }).click();
    await expect(page.getByText(RECEIVER_URL)).toBeVisible();
    await page.reload();
    await expect(page.getByText(/whsec_/)).toHaveCount(0);

    receiver = startReceiver(secret);
    await expect.poll(receiver.output, { timeout: 20_000 }).toContain("Webhook receiver on");

    // A pay-out that gets paid fires payout.paid (the endpoint's default events).
    const bob = await userPage(browser, "bob");
    const payout = await createPayout(bob.request, 777, "Webhook Co");
    await approve(page.request, payout.id);
    await expect.poll(receiver.output, { timeout: 30_000 }).toMatch(new RegExp(`✓ payout\\.paid\\s+${payout.id} paid 777 USD`));
    expect(receiver.output()).not.toContain("rejected");
    await bob.context().close();

    // The delivery shows as delivered in the admin view.
    await page.getByRole("link", { name: "Deliveries" }).click();
    await expect(page.getByRole("table").getByText("Delivered").first()).toBeVisible();
  } finally {
    receiver?.stop();
  }
});
