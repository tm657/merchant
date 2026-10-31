import { PAYOUT_STATUS_LABEL, PAYOUT_STATUS_STYLE } from "@/lib/payout-messages";
import type { PayoutStatus } from "@mini-payments/shared";

export function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  return (
    <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${PAYOUT_STATUS_STYLE[status]}`}>
      {PAYOUT_STATUS_LABEL[status]}
    </span>
  );
}
