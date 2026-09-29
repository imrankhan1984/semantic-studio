/*
================================================================================
FILE: frontend/src/components/LinkPanel.tsx
================================================================================

SUMMARY
    The small panel a click on an *is a kind of* or *narrower than* line
    opens beside the canvas (relationships 5.2): the link read as a sentence,
    *Employee is a kind of Person*, **Remove this link**, and a link to each
    of its two ends.

BASIC IDEA
    A subclass or broader line is not an entity, so it has no form of its
    own; it is a statement, and this says it and offers the one thing to do
    with it. Removing is one command through the shared runner, so one undo
    step, with *Removing…* while it runs and the server's sentence if it is
    refused. Both ends are buttons that select the entity, as a term link in
    the detail panel does. A link with an end of the project's other kind
    (D-089) says why it is read-only instead of offering Remove.

    It stands where the detail panel stands, as an aside named by its
    sentence, and App shows it in place of the empty panel.

INPUTS / INPUT SOURCES (props)
    - link: the line's kind, ends, and their names.
    - onSelect: select one end.
    - onClose: close the panel (and after a removal).

EXPECTED OUTPUT
    - The panel; RemoveSubClassOf or RemoveBroader through the project store.
================================================================================
*/

import { linkSentence } from "../modeling/sentences";
import type { CanvasLink } from "../types";
import { useRunner } from "./EditParts";

interface Props {
  link: CanvasLink;
  onSelect: (iri: string) => void;
  onClose: () => void;
}

const HEADING_ID = "link-panel-heading";

export default function LinkPanel({ link, onSelect, onClose }: Props) {
  const { busy, errors, run, alive } = useRunner();
  const sentence = linkSentence(link.kind, link.sourceLabel, link.targetLabel);

  const remove = async () => {
    if (busy || link.readOnly) return;
    const done =
      link.kind === "subClassOf"
        ? await run("link", "RemoveSubClassOf", { child: link.source, parent: link.target })
        : await run("link", "RemoveBroader", { concept: link.source, broader: link.target });
    if (done && alive()) onClose();
  };

  return (
    <aside className="detail-panel link-panel" aria-labelledby={HEADING_ID} aria-busy={busy}>
      <div className="detail-header">
        <div>
          <p className="detail-prefixed">{link.kind === "subClassOf" ? "Subclass link" : "Broader link"}</p>
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
        <span className="visually-hidden"> {link.kind === "subClassOf" ? "is a kind of" : "is narrower than"} </span>
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
