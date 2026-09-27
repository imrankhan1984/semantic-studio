/*
================================================================================
FILE: frontend/src/components/useDialogTrap.ts
================================================================================

SUMMARY
    The keyboard behaviour of a modal dialog, as one hook: focus the heading on
    open, keep Tab inside the dialog, call back on Escape, and give focus back
    to whatever held it before the dialog opened.

BASIC IDEA
    The same shape as AboutPanel's, which is the pattern the external-access
    spec names for its two new dialogs. The key handler is on `document`, not
    on the panel: pressing on the panel's own prose blurs focus to <body> in a
    real browser, and a panel-scoped handler would then see neither Escape nor
    Tab. Tab from outside the panel is pulled back to its first control, which
    is what makes it a trap rather than a pair of wrapping edges.

    Unlike About, the caller does not restore focus: the approval dialog can
    be opened by any action anywhere -- an upload, a catalogue row, a graph
    request -- so only the dialog knows what was focused when it appeared. It
    records `document.activeElement` on mount and returns focus there on
    unmount, if that element is still in the document and is not <body>.

    AboutPanel keeps its own inline copy. It is tested as it stands, and the
    About panel is named in this spec only for its wording.

INPUTS / INPUT SOURCES
    - A ref to the dialog element, a ref to its heading, and the Escape
      callback.

EXPECTED OUTPUT
    - Effects only.
================================================================================
*/

import { useEffect, type RefObject } from "react";

/** What Tab may land on. The heading has tabindex="-1" so it can be focused by
 *  script without joining the tab order, hence the exclusion. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function useDialogTrap(
  panelRef: RefObject<HTMLElement | null>,
  headingRef: RefObject<HTMLElement | null>,
  onEscape: () => void,
): void {
  // Heading on open; the previous holder of focus back on close. The ref to
  // the previous element is taken in the effect body, which runs before any
  // child has moved focus.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();
    return () => {
      if (previous && previous !== document.body && previous.isConnected) previous.focus();
    };
    // Mount and unmount only: re-running would steal focus back to the heading.
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panelRef, onEscape]);
}
