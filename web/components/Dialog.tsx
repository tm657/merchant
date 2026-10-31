"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Props = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** false while something is in flight: Escape and the close button do nothing. */
  dismissible?: boolean;
  children: ReactNode;
};

/**
 * Modal dialog on the native <dialog> element. showModal() makes the rest of the page
 * inert; on top of that, Tab and Shift+Tab are kept inside the dialog, Escape closes it
 * (when dismissible), and focus goes back to whatever opened it. Children mount only
 * while open, so their state starts fresh every time.
 */
export function Dialog({ open, onClose, title, description, dismissible = true, children }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const returnFocusTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      // Prefer a field marked data-autofocus, else the first focusable element.
      const target = dialog.querySelector<HTMLElement>("[data-autofocus]") ?? dialog.querySelector<HTMLElement>(FOCUSABLE);
      target?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
      returnFocusTo.current?.focus();
    }
  }, [open]);

  // Unmounting while open (e.g. navigating away) still returns focus.
  useEffect(() => () => returnFocusTo.current?.focus(), []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDialogElement>) {
    if (e.key !== "Tab") return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (items.length === 0) {
      e.preventDefault();
      return;
    }
    const first = items[0]!;
    const last = items.at(-1)!;
    if (e.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onKeyDown={onKeyDown}
      // Escape: the browser would close it on its own; keep React in charge instead.
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      className="m-auto w-full max-w-lg rounded-xl border border-zinc-200 bg-white p-0 text-zinc-900 shadow-xl backdrop:bg-black/40 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
    >
      {open && (
        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              disabled={!dismissible}
              aria-label="Close dialog"
              className="rounded-md px-2 py-1 text-zinc-500 hover:bg-zinc-100 disabled:opacity-40 dark:hover:bg-zinc-800"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
