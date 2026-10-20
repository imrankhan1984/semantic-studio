/*
================================================================================
FILE: frontend/src/components/ReusePlan.tsx
================================================================================

SUMMARY
    The reuse plan of attribute-reuse 5.2: what using an existing attribute
    or relationship on one more class means, in the person's names, before
    anything is written, and the one or more choices that do it. Also the
    5.4 Fix for two rdfs:domain lines, which is the same choice without a
    new class.

BASIC IDEA
    The server alone decides the case: the plan is ShareDomain's dry run,
    asked once as the form opens, and its answer is worded here through
    modeling/sentences.ts. Case A gives the property to the class, case B
    says the class has it already and writes nothing, case C moves it up,
    and case D offers, in this order: making the class a kind of the domain
    (the right answer whenever it is true), sharing it -- as an OWL union
    when every class is an OWL class, its Turtle shown small, with a shared
    parent as the second button, or only a shared parent when any is an
    RDFS class -- and moving it up to a parent the classes already share,
    naming what else gains it. A shared parent is never offered for an
    imported class, and the plan says why.

    Every choice is one command and one undo step, run through the form's
    runner, and the live region says what changed. The first choice takes
    focus when the plan arrives (5.5); Cancel and a finished choice are the
    caller's to place focus after.

INPUTS / INPUT SOURCES (props)
    - pid, ontologyId: the project, and its model for the parent picker.
    - property: the property to reuse; cls: the class to reuse it on, or
      null for the 5.4 Fix.
    - runner: the form's command runner.
    - onDone, onCancel: after a choice, or Cancel; onAlready: case B, with
      its sentence.

EXPECTED OUTPUT
    - The plan's sentences and buttons; ShareDomain or AddSubClassOf.
================================================================================
*/

import { useEffect, useId, useRef, useState } from "react";
import { planShare } from "../api";
import {
  OR_PARENT,
  SHARE_IT,
  gainsSentence,
  giveParent,
  givenAnnouncement,
  importedParentNote,
  makeKindOf,
  moveUpTo,
  parentQuestion,
  planAlready,
  planMoveUp,
  planNoClass,
  planRdfsParent,
  planSubclass,
  planUnion,
  sharedAnnouncement,
} from "../modeling/sentences";
import type { SharePlan } from "../types";
import type { Runner } from "./EditParts";
import EntityPicker from "./EntityPicker";

interface Props {
  pid: string;
  ontologyId: string;
  property: { iri: string; label: string };
  cls: { iri: string; label: string } | null;
  runner: Runner;
  onDone: () => void;
  onCancel: () => void;
  onAlready?: (sentence: string) => void;
}

export default function ReusePlan({ pid, ontologyId, property, cls, runner, onDone, onCancel, onAlready }: Props) {
  const { busy, errors, run } = runner;
  const id = useId();
  const [plan, setPlan] = useState<SharePlan | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [parentOpen, setParentOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [parentName, setParentName] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const parentField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    planShare(pid, property.iri, cls?.iri)
      .then((answer) => live && setPlan(answer.plan))
      .catch((e: unknown) => live && setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [pid, property.iri, cls?.iri]);

  // Case B writes nothing: the caller closes the form and says why. Once,
  // when the plan arrives, whatever the caller's callback is by then.
  const already = useRef(onAlready);
  already.current = onAlready;
  useEffect(() => {
    if (plan?.case === "B" && cls && already.current) {
      already.current(planAlready(property.label, cls.label, plan.via?.label ?? cls.label));
    }
  }, [plan, cls, property.label]);

  // The first choice takes focus when the plan arrives (5.5).
  useEffect(() => {
    if (!plan) return;
    box.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [plan]);

  useEffect(() => {
    if (parentOpen) parentField.current?.focus();
  }, [parentOpen]);

  const name = property.label;
  const word = plan?.property.kind === "relationship" ? "relationship" : "attribute";
  const domain = plan?.domain.classes.map((c) => c.label) ?? [];
  const everyone = cls ? [...domain, cls.label] : domain;
  // What the union will hold: a member that is a kind of the class is
  // covered by it and left out, so the server's list, not everyone.
  const united = plan?.union?.map((c) => c.label) ?? everyone;

  const share = async (args: Record<string, unknown>, said: string) => {
    if (busy) return;
    const body = { property: property.iri, ...(cls ? { class: cls.iri } : {}), ...args };
    if (await run("reuse", "ShareDomain", body, () => said)) onDone();
  };

  const cancel = (
    <button type="button" className="ghost" onClick={onCancel}>
      Cancel
    </button>
  );
  const error = errors.reuse ? <p className="edit-error">{errors.reuse}</p> : null;

  if (failed) {
    return (
      <div className="reuse-plan" role="group" aria-label={`Use ${name}`}>
        <p className="edit-error">{failed}</p>
        <div className="edit-actions">{cancel}</div>
      </div>
    );
  }
  if (!plan) {
    return (
      <p className="detail-note" role="status">
        Checking {name}…
      </p>
    );
  }
  if (plan.case === null || plan.case === "B") {
    return (
      <div className="reuse-plan" role="group" aria-label={`Use ${name}`} ref={box}>
        <p>{plan.case === "B" && cls ? planAlready(name, cls.label, plan.via?.label ?? cls.label) : plan.refused}</p>
        <div className="edit-actions">{cancel}</div>
      </div>
    );
  }

  const choices = plan.choices;
  const parentForm = (
    <div className="reuse-parent">
      {picking ? (
        <EntityPicker
          ontologyId={ontologyId}
          kind="class"
          label="An existing class as the parent"
          exclude={plan.domain.classes.map((c) => c.iri).concat(cls ? [cls.iri] : [])}
          busy={busy}
          onCancel={() => setPicking(false)}
          onPick={(parent) => void share({ how: "parent", parent }, sharedAnnouncement(name, everyone))}
        />
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (parentName.trim()) void share({ how: "parent", parentLabel: parentName.trim() }, sharedAnnouncement(name, everyone));
          }}
        >
          <label htmlFor={`${id}-parent`} className="edit-field-label">
            {parentQuestion(everyone)}
          </label>
          <input
            id={`${id}-parent`}
            ref={parentField}
            value={parentName}
            readOnly={busy}
            onChange={(e) => setParentName(e.target.value)}
          />
          <div className="edit-actions">
            <button type="submit" className="primary" aria-disabled={busy || !parentName.trim()}>
              {giveParent(everyone)}
            </button>
            <button type="button" className="link-btn" onClick={() => setPicking(true)}>
              Choose an existing class instead
            </button>
          </div>
        </form>
      )}
    </div>
  );

  return (
    <div className="reuse-plan" role="group" aria-label={`Use ${name}`} ref={box}>
      {plan.case === "A" && cls && (
        <>
          <p>{planNoClass(name, cls.label)}</p>
          <button type="button" className="primary" aria-disabled={busy} onClick={() => void share({}, givenAnnouncement(name, cls.label))}>
            Yes
          </button>
        </>
      )}
      {plan.case === "C" && cls && (
        <>
          <p>{planMoveUp(name, cls.label, domain)}</p>
          <button type="button" className="primary" aria-disabled={busy} onClick={() => void share({}, givenAnnouncement(name, cls.label))}>
            Move it up
          </button>
        </>
      )}
      {choices && choices.subclass && cls && (
        <div className="reuse-choice">
          <p>{planSubclass(name, cls.label, domain[0])}</p>
          <button
            type="button"
            aria-disabled={busy}
            onClick={async () => {
              if (busy) return;
              const said = `${cls.label} is now a kind of ${domain[0]}, and has ${name}.`;
              if (await run("reuse", "AddSubClassOf", { child: cls.iri, parent: plan.domain.classes[0].iri }, () => said)) onDone();
            }}
          >
            {makeKindOf(cls.label, domain[0])}
          </button>
        </div>
      )}
      {choices && choices.union && (
        <div className="reuse-choice">
          <p>{planUnion(word, name, united)}</p>
          {plan.turtle && (
            <pre className="reuse-turtle" aria-label="The Turtle it writes">
              <code>{plan.turtle}</code>
            </pre>
          )}
          <button type="button" aria-disabled={busy} onClick={() => void share({ how: "union" }, sharedAnnouncement(name, united))}>
            {SHARE_IT}
          </button>
          {choices.parent && !parentOpen && (
            <button type="button" className="link-btn" onClick={() => setParentOpen(true)}>
              {OR_PARENT}
            </button>
          )}
          {choices.parent && parentOpen && parentForm}
        </div>
      )}
      {choices && !choices.union && choices.parent && (
        <div className="reuse-choice">
          <p>{planRdfsParent(name, everyone)}</p>
          {parentForm}
        </div>
      )}
      {choices && !choices.parent && plan.imported && plan.imported.length > 0 && (
        <p className="detail-note">{importedParentNote(plan.imported[0].label, plan.imported[0].from)}</p>
      )}
      {choices?.up.map((up) => (
        <div className="reuse-choice" key={up.iri}>
          <p className="detail-note">{gainsSentence(name, up.label, up.gains.map((g) => g.label), up.gainsTotal)}</p>
          <button type="button" aria-disabled={busy} onClick={() => void share({ how: "up", parent: up.iri }, givenAnnouncement(name, up.label))}>
            {moveUpTo(name, up.label)}
          </button>
        </div>
      ))}
      {error}
      <div className="edit-actions">{cancel}</div>
    </div>
  );
}
