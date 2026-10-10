/*
================================================================================
FILE: frontend/src/components/InferredBlock.tsx
================================================================================

SUMMARY
    The detail panel's **Inferred** block (axioms-and-reasoning 5.7): what a
    current reasoning result concluded about the selected entity -- its new
    kinds, memberships and links, each with **Why?** -- and, for a class,
    that it can never have members. Shown under the stated statements,
    behind Show inferred, and never editable.

BASIC IDEA
    The facts are the server's (GET reasoning?about=), fetched again when
    the entity, the result or the revision moves; App only mounts this while
    the result is current, so a stale result's facts never show. The block
    is outlined dashed and headed *Inferred* in words. The other end of each
    fact is a link through the app's selection, as the tree's rows are.

INPUTS / INPUT SOURCES (props)
    - projectId, iri, imports: which entity, in which view.
    - resultKey, revision: refetch when either moves.
    - onSelect: select an entity.

EXPECTED OUTPUT
    - The block, or nothing until the facts arrive.
================================================================================
*/

import { useEffect, useState } from "react";
import { getReasoningAbout } from "../api";
import { NEVER_MEMBERS } from "../reasoning/reasonSentences";
import type { ReasoningAbout } from "../types";
import WhyDisclosure from "./WhyDisclosure";

interface Props {
  projectId: string;
  iri: string;
  imports: boolean;
  resultKey: string;
  revision: number;
  label: string;
  onSelect: (iri: string) => void;
}

export default function InferredBlock({ projectId, iri, imports, resultKey, revision, label, onSelect }: Props) {
  const [about, setAbout] = useState<ReasoningAbout | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getReasoningAbout(projectId, iri, imports)
      .then((found) => !cancelled && setAbout(found))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [projectId, iri, imports, resultKey, revision]);

  if (error) {
    return (
      <section className="detail-inferred">
        <h3>Inferred</h3>
        <p className="detail-error">{error}</p>
      </section>
    );
  }
  if (!about || about.iri !== iri || about.stale) return null;
  return (
    <section className="detail-inferred" aria-label={`Inferred about ${label}`}>
      <h3>
        Inferred <span className="count">{about.facts.length}</span>
      </h3>
      {about.neverMembers && <p className="detail-note">{`${label} ${NEVER_MEMBERS}.`}</p>}
      {about.facts.length === 0 && !about.neverMembers && (
        <p className="detail-note">Reasoning concluded nothing new about {label}.</p>
      )}
      {about.facts.length > 0 && (
        <ul className="detail-inferred-facts">
          {about.facts.map((fact) => {
            const other = fact.s === iri ? fact.o : fact.s;
            return (
              <li key={`${fact.s}|${fact.p}|${fact.o}`}>
                <button type="button" className="term-link" onClick={() => onSelect(other)}>
                  {fact.sentence}
                </button>{" "}
                <span className="why-mark">inferred</span>{" "}
                <WhyDisclosure projectId={projectId} fact={fact} label={fact.sentence} onSelect={onSelect} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
