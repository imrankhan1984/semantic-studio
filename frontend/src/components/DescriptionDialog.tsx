/*
================================================================================
FILE: frontend/src/components/DescriptionDialog.tsx
================================================================================

SUMMARY
    The project's description, changed later (reference-ontologies 5.5): a
    small dialog from the Edit project bar's ⋯ menu with the New project
    form's text area, the header's current rdfs:comment in the primary
    language, and Save and Cancel.

BASIC IDEA
    The header is the model's owl:Ontology, which every change response's
    document state names; its comment is read from the node's details, the
    one place the detail panel already reads it. Save is one SetComment on
    the header, through the project store, so it is one undo step and the
    live region says *Description saved.* -- for every project, those made
    before E-12 included, since nothing here depends on how the project
    began.

    SetComment replaces the comment in a language and refuses an empty one,
    so an empty field gives no Save, with the reason beside it, as Create's
    is; past 2,000 characters the same counter as New project says so.

    The About dialog's pattern (5.8): the backdrop is the dialog's sibling,
    the key handler is on `document` (useDialogTrap), Escape and ✕ close,
    and focus goes back to what opened it -- the ⋯ button, which the menu
    focuses before opening this.

INPUTS / INPUT SOURCES (props)
    - ontologyId, header, primaryLanguage: whose comment, and in which
      language.
    - onClose: every exit, after a save too.
    Plus getNodeDetails and the project store.

EXPECTED OUTPUT
    - The dialog; one SetComment per Save.
================================================================================
*/

import { useCallback, useEffect, useRef, useState } from "react";
import { getNodeDetails } from "../api";
import { DESCRIPTION_MAX } from "../projects/form";
import { projectStore } from "../state/projectStore";
import { useDialogTrap } from "./useDialogTrap";

const RDFS_COMMENT = "http://www.w3.org/2000/01/rdf-schema#comment";

interface Props {
  ontologyId: string;
  header: string;
  primaryLanguage: string;
  onClose: () => void;
}

export default function DescriptionDialog({ ontologyId, header, primaryLanguage, onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    if (!busy) onClose();
  }, [busy, onClose]);
  useDialogTrap(panelRef, headingRef, close);

  useEffect(() => {
    let live = true;
    getNodeDetails(ontologyId, header)
      .then((details) => {
        if (!live) return;
        const comment = details.outgoing.find(
          (o) =>
            o.predicate.value === RDFS_COMMENT &&
            o.object.type === "literal" &&
            (o.object.lang ?? "").toLowerCase() === primaryLanguage.toLowerCase(),
        );
        setText(comment?.object.value ?? "");
      })
      .catch((e: unknown) => {
        if (!live) return;
        setText("");
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [ontologyId, header, primaryLanguage]);

  const value = (text ?? "").trim();
  const over = value.length > DESCRIPTION_MAX;
  const reason =
    text === null
      ? "Reading the description…"
      : !value
        ? "Write a description to save it."
        : over
          ? `A description can be at most ${DESCRIPTION_MAX.toLocaleString("en")} characters.`
          : null;

  const save = async () => {
    if (reason || busy) return;
    setBusy(true);
    setError(null);
    try {
      await projectStore.command(
        "SetComment",
        { iri: header, value, lang: primaryLanguage },
        () => "Description saved.",
        "model",
      );
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      {/* A sibling of the dialog, as About's: aria-hidden on an ancestor
          would take the dialog out of the accessibility tree with it. */}
      <div className="modal-backdrop confirm-backdrop" aria-hidden="true" onClick={close} />
      <div
        ref={panelRef}
        className="confirm-dialog description-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="description-dialog-title"
      >
        <button type="button" className="icon-btn about-close" onClick={close} aria-label="Close Description">
          ✕
        </button>
        <h2 id="description-dialog-title" ref={headingRef} tabIndex={-1} className="confirm-title">
          Description
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="form-field">
            <label htmlFor="description-dialog-text">What this project is about ({primaryLanguage})</label>
            <textarea
              id="description-dialog-text"
              rows={5}
              value={text ?? ""}
              readOnly={text === null || busy}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={over ? true : undefined}
              aria-describedby="description-dialog-hint description-dialog-count"
            />
            <p id="description-dialog-hint" className="form-hint">
              Saved as the ontology&apos;s rdfs:comment, where other tools read it. One step of Undo.
            </p>
            <p id="description-dialog-count" className="form-error" aria-live="polite">
              {over
                ? `${value.length.toLocaleString("en")} of ${DESCRIPTION_MAX.toLocaleString("en")} characters: shorten it by ${(value.length - DESCRIPTION_MAX).toLocaleString("en")}.`
                : ""}
            </p>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="modal-actions">
            <button type="button" className="ghost" onClick={close} aria-disabled={busy}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              aria-disabled={reason !== null || busy}
              aria-describedby={reason ? "description-dialog-reason" : undefined}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
          {reason && (
            <p id="description-dialog-reason" className="form-hint new-project-reason">
              {reason}
            </p>
          )}
        </form>
      </div>
    </>
  );
}
