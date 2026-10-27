/*
================================================================================
FILE: frontend/src/components/ClassKindBlock.tsx
================================================================================

SUMMARY
    The *Kind of class* block of a class's form (attribute-reuse 5.7,
    D-117): what the class is, *OWL class* or *RDFS class*, and the button
    that makes it the other. Making an OWL class RDFS lists first what RDFS
    cannot carry about it -- its rules, its disjoint and its equivalent
    classes, in the Rules block's sentences -- and changes nothing until
    *Make it an RDFS class* is pressed; Cancel changes nothing.

BASIC IDEA
    The server alone decides what goes and whether the change is allowed:
    the list is SetClassType's dry run, worded here through
    modeling/ruleSentences.ts as the Rules block words the same items, and a
    refusal (a member of a union domain, a group of disjoint classes) is
    the server's sentence. RDFS to OWL loses nothing, so it runs at once.
    Either change is one command and one undo step, through the form's
    runner, and the live region says what the class is now.

    A list is for one class, one kind and one revision: any of them moving
    closes it, and an answer to an older question is dropped, so the list
    shown is always the one the button will act on.

    Focus: the first button takes it when the list or the refusal arrives
    (as the reuse plan's does, 5.5); Cancel, and a finished change, give it
    back to the block's button, drawn again once the form refetches.

INPUTS / INPUT SOURCES (props)
    - iri, name: the class; classType: what it is now, from /node.
    - runner: the form's command runner.

EXPECTED OUTPUT
    - The block's markup; SetClassType through the runner.
================================================================================
*/

import { useEffect, useRef, useState } from "react";
import { planClassType } from "../api";
import { itemKey, itemSentence } from "../modeling/ruleSentences";
import {
  CHECKING_KIND,
  CLASS_KIND_LEGEND,
  becomesRdfs,
  classKindName,
  kindChangedAnnouncement,
  makeItKind,
} from "../modeling/sentences";
import { projectStore, useProjectSelector } from "../state/projectStore";
import type { ClassType, ClassTypePlan } from "../types";
import type { Runner } from "./EditParts";

interface Props {
  iri: string;
  name: string;
  classType: ClassType;
  runner: Runner;
}

type Asking = null | "checking" | { plan: ClassTypePlan } | { failed: string };

export default function ClassKindBlock({ iri, name, classType, runner }: Props) {
  const { busy, errors, run, clear } = runner;
  const [asking, setAsking] = useState<Asking>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const other: ClassType = classType === "owl" ? "rdfs" : "owl";
  // A plan is for one class, one kind and one revision: another class, or
  // any change made meanwhile (an undo, Turtle), starts afresh, and an
  // answer to an older question is dropped (code review).
  const revision = useProjectSelector((s) => s.documents.find((d) => d.doc === "model")?.revision ?? 0);
  const question = useRef(0);
  useEffect(() => {
    question.current++;
    setAsking(null);
  }, [iri, classType, revision]);

  const settled = asking !== null && asking !== "checking";
  useEffect(() => {
    if (settled) box.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [settled]);

  const back = () => window.setTimeout(() => opener.current?.focus(), 0);

  const change = async () => {
    if (busy) return;
    const done = await run("kind", "SetClassType", { class: iri, type: other }, () =>
      kindChangedAnnouncement(name, other),
    );
    if (done) {
      setAsking(null);
      back();
    }
  };

  const ask = async () => {
    if (busy) return;
    clear("kind");
    // Nothing is lost going to OWL (5.7): no list to read first.
    if (other === "owl") return void change();
    const project = projectStore.getSnapshot().project;
    if (!project) return;
    setAsking("checking");
    const asked = ++question.current;
    try {
      const answer = await planClassType(project.id, iri, other);
      if (asked === question.current) setAsking({ plan: answer.plan });
    } catch (e) {
      if (asked === question.current) setAsking({ failed: e instanceof Error ? e.message : String(e) });
    }
  };

  const cancel = () => {
    setAsking(null);
    clear("kind");
    back();
  };

  const plan = asking && typeof asking === "object" && "plan" in asking ? asking.plan : null;
  const refusal = plan?.refused ?? (asking && typeof asking === "object" && "failed" in asking ? asking.failed : null);

  return (
    <div className="class-kind-block">
      <h5>{CLASS_KIND_LEGEND}</h5>
      <p className="detail-note">{classKindName(classType)}</p>
      {asking === null && (
        <button ref={opener} type="button" className="ghost" aria-disabled={busy} onClick={() => void ask()}>
          {makeItKind(other)}
        </button>
      )}
      {asking === "checking" && (
        <p className="detail-note" role="status">
          {CHECKING_KIND}
        </p>
      )}
      {settled && (
        <div ref={box} role="group" aria-label={makeItKind(other)}>
          {refusal ? (
            <p className="edit-error">{refusal}</p>
          ) : (
            plan && (
              <>
                <p>{becomesRdfs(name, plan.goes.length)}</p>
                {plan.goes.length > 0 && (
                  <ul>
                    {plan.goes.map((item) => (
                      <li key={itemKey(item)}>
                        {item.type === "turtle" ? (
                          <pre className="rule-turtle">{item.turtle}</pre>
                        ) : (
                          `“${itemSentence(name, item)}”`
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )
          )}
          <div className="edit-actions">
            {plan && !plan.refused && (
              <button type="button" className="primary" aria-disabled={busy} onClick={() => void change()}>
                {busy ? "Saving change…" : makeItKind(other)}
              </button>
            )}
            <button type="button" className="ghost" onClick={cancel}>
              {refusal ? "Close" : "Cancel"}
            </button>
          </div>
        </div>
      )}
      {errors.kind && <p className="edit-error">{errors.kind}</p>}
    </div>
  );
}
