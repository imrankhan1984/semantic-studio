/*
================================================================================
FILE: frontend/src/components/SharedDomain.tsx
================================================================================

SUMMARY
    *Belongs to* (an attribute) or *From* (a relationship) when the domain
    is several classes, and *Add a class* for any property that has one
    (attribute-reuse 5.3, 5.4). A union's members, read *any one of these*,
    each with Remove; two domain lines, read *all of these at once*, with
    the 5.4 warning and its **Share it**; the reasoner's limit for a union
    (Section 7); and the reuse plan for a class added here or for the Fix.

BASIC IDEA
    The domain is the server's one reading (`domainReading`), never the
    statements, which reach a union only through a blank node. Remove is
    UnshareDomain: the server never leaves a union of one. *Add a class*
    picks a class and opens ReusePlan for it, the same plan the class form
    gives; the Fix for two domain lines is ShareDomain itself when every
    class is an OWL class, and the plan with its shared parent's name field
    when one is RDFS. Every control is aria-disabled while a change saves.

INPUTS / INPUT SOURCES (props)
    - ontologyId, iri, name, model: the property and its blocks.
    - runner: the form's; onSelect: select a class.
    - warnings: the property's; the one under block "domain" is shown here.
    - members: whether to list the classes (a shared domain), or only offer
      *Add a class* below the one-class block the form draws itself.

EXPECTED OUTPUT
    - UnshareDomain and ShareDomain through the runner; the block's markup.
================================================================================
*/

import { useRef, useState } from "react";
import type { EntityModel } from "../modeling/entity";
import { REASONER_NOTE, SHARE_IT, domainListNote, removedAnnouncement, sharedAnnouncement } from "../modeling/sentences";
import { useProjectSelector } from "../state/projectStore";
import type { ModelWarning } from "../types";
import type { Runner } from "./EditParts";
import EntityPicker from "./EntityPicker";
import ReusePlan from "./ReusePlan";

interface Props {
  ontologyId: string;
  iri: string;
  name: string;
  model: EntityModel;
  runner: Runner;
  onSelect: (iri: string) => void;
  warnings?: ModelWarning[];
  members: boolean;
}

export default function SharedDomain({ ontologyId, iri, name, model, runner, onSelect, warnings = [], members }: Props) {
  const { busy, errors, run } = runner;
  const pid = useProjectSelector((s) => s.project?.id ?? null);
  const [picking, setPicking] = useState(false);
  // The plan open here: for a class picked, or (null) the 5.4 Fix's.
  const [planning, setPlanning] = useState<{ cls: { iri: string; label: string } | null } | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const reading = model.domainReading;
  const classes = reading?.classes ?? [];
  const separate = warnings.find((w) => w.block === "domain");
  const focusAdd = () => window.setTimeout(() => addRef.current?.focus(), 0);

  return (
    <>
      {members && reading && (reading.form === "union" || reading.form === "separate") && (
        <>
          <p className="detail-note">{domainListNote(reading.form)}</p>
          <ul className="edit-list">
            {classes.map((c) => (
              <li key={c.iri}>
                <button type="button" className="term-link" title={c.iri} onClick={() => onSelect(c.iri)}>
                  {c.label}
                </button>
                <button
                  type="button"
                  className="ghost edit-btn"
                  aria-label={`Remove ${c.label} from ${name}`}
                  aria-disabled={busy}
                  onClick={async () => {
                    if (busy) return;
                    if (await run("domainList", "UnshareDomain", { property: iri, class: c.iri }, () => removedAnnouncement(name, c.label))) {
                      focusAdd();
                    }
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
          {reading.form === "union" && <p className="detail-note">{REASONER_NOTE}</p>}
        </>
      )}
      {separate && (
        <div className="form-warnings" role="group" aria-label="Warning">
          <p className="form-warning">{separate.text}</p>
          {separate.fix && (
            <button
              type="button"
              aria-disabled={busy}
              onClick={() => {
                if (busy || !separate.fix) return;
                // A shared parent needs its name: the plan asks for it.
                if (separate.fix.needs === "parentName") setPlanning({ cls: null });
                else void run("fix", separate.fix.command, separate.fix.args, () => sharedAnnouncement(name, classes.map((c) => c.label)));
              }}
            >
              {SHARE_IT}
            </button>
          )}
          {errors.fix && <p className="edit-error">{errors.fix}</p>}
        </div>
      )}
      {/* With one class the form above shows the refusal; said once. */}
      {members && errors.domainList && <p className="edit-error">{errors.domainList}</p>}
      {planning && pid ? (
        <ReusePlan
          pid={pid}
          ontologyId={ontologyId}
          property={{ iri, label: name }}
          cls={planning.cls}
          runner={runner}
          onDone={() => {
            setPlanning(null);
            focusAdd();
          }}
          onAlready={() => undefined}
          onCancel={() => {
            setPlanning(null);
            focusAdd();
          }}
        />
      ) : picking ? (
        <EntityPicker
          ontologyId={ontologyId}
          kind="class"
          label={`Another class for ${name}`}
          exclude={classes.map((c) => c.iri)}
          busy={busy}
          onCancel={() => {
            setPicking(false);
            focusAdd();
          }}
          onPick={(target, label) => {
            setPicking(false);
            setPlanning({ cls: { iri: target, label } });
          }}
        />
      ) : (
        classes.length > 0 && (
          <button ref={addRef} type="button" className="ghost" aria-label={`Add a class to ${name}`} onClick={() => setPicking(true)}>
            Add a class
          </button>
        )
      )}
    </>
  );
}
