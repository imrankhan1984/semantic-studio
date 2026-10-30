/*
================================================================================
FILE: frontend/src/components/RemoveDialog.tsx
================================================================================

SUMMARY
    The question before an ontology is removed (wording-and-query-export 5.11,
    5.14), in place of window.confirm, which could not offer a button: its
    sentence is removalPrompt's, unchanged, and its answers are Cancel,
    Remove and, when queries are saved against it, Download them first.

BASIC IDEA
    Removing an ontology deletes every query saved against it. The dialog
    lets them leave first as one zip (D-122) and stays open while they do:
    the button reads *Preparing…* and is aria-disabled, so it keeps the
    focus it holds; once the file is handed to the browser a polite live
    region inside the dialog names it and the button reads *Download again*.
    A failure is a sentence in the dialog, and Remove stays where it was,
    because a failed download has removed nothing.

    The keyboard is useDialogTrap's, the pattern every dialog here shares,
    with one difference the spec asks for: focus starts on Cancel, the safe
    answer to a removal, rather than on the heading. Escape is Cancel. The
    trap gives focus back on close to what held it on open, the card's ⋮,
    which the card focused before the count began; after Remove that card is
    gone and Home's own refocus applies.

    Remove is a word, *Remove*, with the danger style as a second signal,
    never the only one.

INPUTS / INPUT SOURCES (props)
    - name, savedQueries, names: as removalPrompt takes them; savedQueries
      null when the count failed.
    - onDownload: prepares and saves the zip, resolving with the file name;
      App's, over api.ts and download.ts.
    - onCancel, onRemove.

EXPECTED OUTPUT
    - The dialog; one onCancel or onRemove per answer, any number of
      onDownload calls.
================================================================================
*/

import { useCallback, useRef, useState } from "react";
import {
  REMOVE_HEADING,
  downloadFailed,
  downloadLabel,
  downloadedSentence,
  offersDownload,
  removalPrompt,
} from "../removalPrompt";
import { useDialogTrap } from "./useDialogTrap";

interface Props {
  name: string;
  savedQueries: number | null;
  names: string[];
  onDownload: () => Promise<string>;
  onCancel: () => void;
  onRemove: () => void;
}

export default function RemoveDialog({ name, savedQueries, names, onDownload, onCancel, onRemove }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<"idle" | "preparing" | "done">("idle");
  const [announced, setAnnounced] = useState("");
  const [failed, setFailed] = useState(false);
  const cancel = useCallback(() => onCancel(), [onCancel]);
  // Cancel is the element the trap focuses on open (5.14).
  useDialogTrap(panelRef, cancelRef, cancel);

  const download = async () => {
    if (state === "preparing" || !offersDownload(savedQueries)) return;
    setState("preparing");
    setFailed(false);
    setAnnounced("");
    try {
      const filename = await onDownload();
      setState("done");
      setAnnounced(downloadedSentence(savedQueries, filename));
    } catch {
      setState("idle");
      setFailed(true);
    }
  };

  return (
    <>
      <div className="modal-backdrop confirm-backdrop" aria-hidden="true" onClick={cancel} />
      <div
        ref={panelRef}
        className="confirm-dialog remove-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="remove-dialog-title"
        aria-describedby="remove-dialog-sentence"
      >
        <h2 id="remove-dialog-title" className="confirm-title">
          {REMOVE_HEADING}
        </h2>
        <div className="confirm-body">
          <p id="remove-dialog-sentence">{removalPrompt(name, savedQueries, names)}</p>
          {failed && offersDownload(savedQueries) && <p className="detail-error">{downloadFailed(savedQueries)}</p>}
          {/* Rendered whether or not it has anything to say: a live region
              added with its text is unreliably announced. */}
          <p className="visually-hidden" role="status">
            {announced}
          </p>
        </div>
        <div className="modal-actions">
          <button ref={cancelRef} className="ghost" onClick={cancel}>
            Cancel
          </button>
          {offersDownload(savedQueries) && (
            <button
              className="ghost"
              // aria-disabled, never disabled, while the file is prepared: a
              // disabled button drops the focus it holds.
              aria-disabled={state === "preparing"}
              onClick={() => void download()}
            >
              {downloadLabel(savedQueries, state)}
            </button>
          )}
          <button className="ghost danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      </div>
    </>
  );
}
