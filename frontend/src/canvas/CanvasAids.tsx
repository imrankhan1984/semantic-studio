/*
================================================================================
FILE: frontend/src/canvas/CanvasAids.tsx
================================================================================

SUMMARY
    What the canvas says about itself (edit-page-rework 5.5, 5.7): the
    legend at its lower right -- one sample line per kind of line, each
    with its word, and a **?** that opens the keyboard help -- and the
    first-use tip card at its lower left, naming the three drags once.

BASIC IDEA
    The legend replaces the tree's old *Showing asserted…* note. Each
    sample is drawn with the same class as the canvas's own lines, so it
    can never show a pattern the canvas does not; and each has its word,
    since colour is never the only signal (5.8).

    The help is ConfirmDialog with one Close: a modal with its heading
    focused, Tab kept inside, Escape closing, and focus given back to **?**.

    The tip card is shown until dismissed, once per browser. Its flag is in
    localStorage, read and written in try/catch: a private window or blocked
    storage shows the tip and forgets the dismissal, and never throws.

INPUTS / INPUT SOURCES (props)
    - Legend: the line kinds to show, in order.
    - TipCard: the palette's word, Class or Concept.
    Plus localStorage, for the tip card's flag.

EXPECTED OUTPUT
    - The legend, the help dialog, the tip card.
================================================================================
*/

import { useState } from "react";
import ConfirmDialog from "../components/ConfirmDialog";

export type LegendLine = "kindof" | "relationship" | "broader" | "related" | "inferred" | "rule";

const WORDS: Record<LegendLine, string> = {
  kindof: "kind of",
  relationship: "relationship",
  broader: "broader",
  related: "related",
  inferred: "inferred",
  rule: "rule",
};

/** Where each sample's ends are drawn: the canvas's own markers. */
const MARKERS: Record<LegendLine, { start?: string; end?: string }> = {
  kindof: { end: "url(#canvas-hollow-kindof)" },
  relationship: { end: "url(#canvas-arrow-relationship)" },
  broader: { end: "url(#canvas-hollow-broader)" },
  related: { start: "url(#canvas-dot-related)", end: "url(#canvas-dot-related)" },
  inferred: { end: "url(#canvas-hollow-kindof)" },
  rule: { end: "url(#canvas-arrow-rule)" },
};

export function Legend({ lines }: { lines: LegendLine[] }) {
  const [help, setHelp] = useState(false);
  return (
    <div className="canvas-legend nodrag nopan">
      <ul aria-label="What the lines mean">
        {lines.map((line) => (
          <li key={line}>
            <svg width="46" height="14" aria-hidden="true">
              <path
                d="M6 7 H30"
                className={`canvas-edge line-${line === "inferred" ? "kindof inferred" : line}`}
                markerStart={MARKERS[line].start}
                markerEnd={MARKERS[line].end}
              />
            </svg>
            {WORDS[line]}
          </li>
        ))}
      </ul>
      <button type="button" className="canvas-help-button" aria-haspopup="dialog" aria-label="Keyboard help" onClick={() => setHelp(true)}>
        ?
      </button>
      {help && (
        <ConfirmDialog
          title="Keyboard and lines"
          escape="close"
          actions={[{ id: "close", label: "Close", primary: true }]}
          onAnswer={() => setHelp(false)}
        >
          <ul className="canvas-help-keys">
            <li>
              <kbd>Shift</kbd>+<kbd>F10</kbd> on an outline row opens its actions.
            </li>
            <li>
              <kbd>Enter</kbd> in a new box creates it; <kbd>Esc</kbd> cancels it.
            </li>
            <li>
              <kbd>Enter</kbd> on a selected box renames it; <kbd>Delete</kbd> deletes it.
            </li>
            <li>
              The arrow keys move the selected box; <kbd>+</kbd> and <kbd>-</kbd> zoom.
            </li>
          </ul>
          <p>
            A solid line is stated in your model. A dashed line is inferred: reasoning concluded it, and it is not saved
            in your file.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

/** The tip card's flag, per browser. */
export const TIP_KEY = "semantic-studio-canvas-tip";

function tipDismissed(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === "dismissed";
  } catch {
    return false;
  }
}

export function TipCard({ word }: { word: "Class" | "Concept" }) {
  const [shown, setShown] = useState(() => !tipDismissed());
  if (!shown) return null;
  const kindOf = word === "Class" ? "a kind of it" : "narrower than it";
  return (
    <section className="canvas-tip nodrag nopan" aria-labelledby="canvas-tip-title">
      <h3 id="canvas-tip-title">Three drags</h3>
      <ul>
        <li>
          Drag <strong>{word}</strong> onto the canvas to add one.
        </li>
        <li>
          Drop it on a box to make {kindOf}.
        </li>
        <li>Drag from a box's edge to another box to relate them.</li>
      </ul>
      <button
        type="button"
        className="ghost"
        onClick={(e) => {
          try {
            localStorage.setItem(TIP_KEY, "dismissed");
          } catch {
            /* the tip comes back next time; nothing else is lost */
          }
          // The card goes: focus to the canvas it sat on, never the page.
          const canvas = e.currentTarget.closest<HTMLElement>(".model-canvas");
          setShown(false);
          canvas?.focus();
        }}
      >
        Got it
      </button>
    </section>
  );
}
