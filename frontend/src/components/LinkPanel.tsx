/*
================================================================================
FILE: frontend/src/components/LinkPanel.tsx
================================================================================

SUMMARY
    The small panel a click on an *is a kind of*, *narrower than* or
    *related to* line opens beside the canvas (relationships 5.2, 5.8): the
    link read as a sentence, *Employee is a kind of Person*, **Remove this
    link**, and a link to each of its two ends. Removing a related link
    removes it both ways, as it was made.

BASIC IDEA
    A subclass or broader line is not an entity, so it has no form of its
    own; it is a statement, and this says it and offers the one thing to do
    with it. Removing is one command through the shared runner, so one undo
    step, with *Removing…* while it runs and the server's sentence if it is
    refused. Both ends are buttons that select the entity, as a term link in
    the detail panel does. A link with an end of the project's other kind
    (D-089), or whose narrower end is imported (relationships 5.10 item 6),
    says why it is read-only instead of offering Remove.

    A refusal belongs to its line: when another line is clicked the panel
    stays mounted with the new link, and the old sentence is cleared rather
    than left standing under it (5.10 item 5).

    It stands where the detail panel stands, as an aside named by its
    sentence, and App shows it in place of the empty panel.

INPUTS / INPUT SOURCES (props)
    - link: the line's kind, ends, and their names.
    - onSelect: select one end.
    - onClose: close the panel (and after a removal).

EXPECTED OUTPUT
    - The panel; RemoveSubClassOf, RemoveBroader or RemoveRelated through the
      project store.
================================================================================
*/

import { useEffect } from "react";
import { linkSentence } from "../modeling/sentences";
import type { CanvasLink } from "../types";
import { useRunner } from "./EditParts";

interface Props {
  link: CanvasLink;
  onSelect: (iri: string) => void;
  onClose: () => void;
}

const HEADING_ID = "link-panel-heading";

const KIND_TITLE: Record<CanvasLink["kind"], string> = {
  subClassOf: "Subclass link",
  broader: "Broader link",
  related: "Related link",
};

const KIND_WORDS: Record<CanvasLink["kind"], string> = {
  subClassOf: "is a kind of",
  broader: "is narrower than",
  related: "is related to",
};

export default function LinkPanel({ link, onSelect, onClose }: Props) {
  const { busy, errors, run, alive, clear } = useRunner();
  useEffect(() => clear("link"), [clear, link.kind, link.source, link.target]);
  const sentence = linkSentence(link.kind, link.sourceLabel, link.targetLabel);

  const remove = async () => {
    if (busy || link.readOnly) return;
    const done =
      link.kind === "subClassOf"
        ? await run("link", "RemoveSubClassOf", { child: link.source, parent: link.target })
        : link.kind === "related"
          ? await run("link", "RemoveRelated", { concept: link.source, related: link.target })
          : await run("link", "RemoveBroader", { concept: link.source, broader: link.target });
    if (done && alive()) onClose();
  };

  return (
    <aside className="detail-panel link-panel" aria-labelledby={HEADING_ID} aria-busy={busy}>
      <div className="detail-header">
        <div>
          <p className="detail-prefixed">{KIND_TITLE[link.kind]}</p>
          <h2 id={HEADING_ID} tabIndex={-1}>
            {sentence}
          </h2>
        </div>
        <button className="icon-btn" onClick={onClose} title="Close panel" aria-label="Close panel">
          ✕
        </button>
      </div>
      <p className="link-panel-ends">
        <button type="button" className="term-link" onClick={() => onSelect(link.source)}>
          {link.sourceLabel}
        </button>
        <span aria-hidden="true"> → </span>
        <span className="visually-hidden"> {KIND_WORDS[link.kind]} </span>
        <button type="button" className="term-link" onClick={() => onSelect(link.target)}>
          {link.targetLabel}
        </button>
      </p>
      {link.readOnly ? (
        <p className="detail-note">{link.readOnly}</p>
      ) : (
        <div className="edit-actions">
          <button type="button" className="ghost danger" aria-disabled={busy} onClick={() => void remove()}>
            {busy ? "Removing…" : "Remove this link"}
          </button>
        </div>
      )}
      {errors.link && (
        <p className="edit-error" role="alert">
          {errors.link}
        </p>
      )}
    </aside>
  );
}
