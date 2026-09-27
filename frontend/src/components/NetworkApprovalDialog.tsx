/*
================================================================================
FILE: frontend/src/components/NetworkApprovalDialog.tsx
================================================================================

SUMMARY
    The question Semantic Studio asks before it connects to a site: which site,
    why, what is sent, and what the site will see, with Allow and Don't allow
    and a choice between just this time and always. The one place a network
    connection is approved (external-access Stage 1, D-066).

BASIC IDEA
    Rendered by App when api.ts's `send` meets a 409 `approval_required`. The
    server has sent nothing at that point; this dialog is the whole of the
    decision. Every row is text from the 409 body or from networkWords.ts --
    the capability's own name is never shown, and nothing depends on colour.

    For a SPARQL SERVICE question the *What is sent* row is the exact query
    text of each block, in a read-only box, because that text is the whole of
    what leaves the machine: the server fixed it before asking and sends it
    byte for byte (D-069). One box per block, named by its endpoint when there
    are several.

    Built on the About panel's pattern: the backdrop is a sibling, not the
    parent, because aria-hidden on an ancestor would remove the dialog from the
    accessibility tree; focus goes to the heading on open, Tab is trapped, and
    Escape or a click on the backdrop means Don't allow, just this time. Focus
    returns to whatever held it when the question appeared (useDialogTrap).

    The radio pair applies to either answer. *Always* with Allow remembers an
    Allow; *Always* with Don't allow remembers a Block, which the Network panel
    lists and can revoke. *Just this time* with Don't allow records nothing.
    The hint under the pair says so, because "Always, for ..." reads as an
    Allow and a remembered refusal should never be a surprise.

    *Always* is preselected, as in the specification's mock-up: most questions
    are about a site the user will meet again, and a repeat of the same
    question is how people learn to click through questions unread.

INPUTS / INPUT SOURCES (props)
    - requests: the approval requests from the 409 body. The broker raises one
      at a time; more than one is handled by listing every host.
    - onAnswer(allow, remember): called once, for either button, Escape or the
      backdrop.

EXPECTED OUTPUT
    - The dialog and its backdrop.
================================================================================
*/

import { useCallback, useRef, useState } from "react";
import { alwaysPhrase } from "../networkWords";
import type { ApprovalRequest } from "../types";
import { useDialogTrap } from "./useDialogTrap";

export const SERVICE_NOTHING_ELSE =
  "Nothing else from your ontology is sent. Results are combined on your machine.";

export const WHY_EXPLAINED = [
  "Some files and queries rely on material published on another site, such as a JSON-LD context or an ontology they import.",
  "Semantic Studio asks before it connects anywhere, so you always know what leaves this computer and where it goes.",
] as const;

interface Props {
  requests: ApprovalRequest[];
  onAnswer: (allow: boolean, remember: boolean) => void;
}

export default function NetworkApprovalDialog({ requests, onAnswer }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [remember, setRemember] = useState(true);
  const first = requests[0];
  const hosts = [...new Set(requests.map((r) => r.host))];
  const texts = requests.filter((r) => r.text !== undefined);
  const heading =
    hosts.length === 1
      ? `Allow a connection to ${hosts[0]}?`
      : `Allow connections to ${hosts.join(", ")}?`;

  const decline = useCallback(() => onAnswer(false, false), [onAnswer]);
  useDialogTrap(panelRef, headingRef, decline);

  return (
    <>
      <div className="modal-backdrop approval-backdrop" aria-hidden="true" onClick={decline} />
      <div
        ref={panelRef}
        className="approval-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-heading"
      >
        <h2 id="approval-heading" ref={headingRef} tabIndex={-1} className="approval-heading">
          {heading}
        </h2>

        <dl className="approval-facts">
          <dt>Why</dt>
          <dd>{first.reason}</dd>
          <dt>What is sent</dt>
          {texts.length === 0 ? (
            <dd>{first.sends}</dd>
          ) : (
            <dd>
              {texts.map((r, i) => (
                <textarea
                  key={i}
                  className="approval-text"
                  readOnly
                  value={r.text}
                  rows={Math.min(12, (r.text ?? "").split("\n").length)}
                  aria-label={
                    texts.length === 1 ? "Query text sent" : `Query text sent to ${r.url}`
                  }
                />
              ))}
              <p className="approval-text-note">{SERVICE_NOTHING_ELSE}</p>
            </dd>
          )}
          <dt>The site sees</dt>
          <dd>Your internet address and the address of what is requested.</dd>
          <dt>Address</dt>
          <dd className="approval-url">
            {[...new Set(requests.map((r) => r.url))].join(", ")}
          </dd>
          {!first.encrypted && (
            <>
              <dt>Encryption</dt>
              <dd>
                This address starts with http://. Semantic Studio tries an encrypted
                connection first, but the site may only offer an unencrypted one.
              </dd>
            </>
          )}
        </dl>

        <details className="approval-why">
          <summary>Why am I seeing this?</summary>
          <p>{WHY_EXPLAINED[0]}</p>
          <p>{WHY_EXPLAINED[1]}</p>
        </details>

        <fieldset className="approval-scope">
          <legend>How long should this answer last?</legend>
          <label>
            <input
              type="radio"
              name="approval-scope"
              checked={!remember}
              onChange={() => setRemember(false)}
            />
            Just this time
          </label>
          <label>
            <input
              type="radio"
              name="approval-scope"
              checked={remember}
              onChange={() => setRemember(true)}
            />
            Always, for {alwaysPhrase(first.capability)} from{" "}
            {hosts.length === 1 ? "this site" : "these sites"}
          </label>
          <p className="approval-hint">
            Always applies to Don't allow too: the site stays blocked until you change it in
            Network settings.
          </p>
        </fieldset>

        <div className="approval-actions">
          <button className="ghost" onClick={() => onAnswer(false, remember)}>
            Don't allow
          </button>
          <button className="primary" onClick={() => onAnswer(true, remember)}>
            Allow
          </button>
        </div>
      </div>
    </>
  );
}
