/*
================================================================================
FILE: frontend/src/components/ConceptRelations.tsx
================================================================================

SUMMARY
    A concept's taxonomy relations beyond broader and narrower
    (relationships-and-project-kinds 5.8): *Top concept of Fruits*, kept by
    the server, its **Related** concepts, added and removed, and its
    **Mappings** to other vocabularies, each kind explained in one sentence,
    to a link or to a concept from an import.

BASIC IDEA
    Part of the concept's Structure block in EditStructure, sharing its
    runner. *Related to* is one command that writes both directions, since
    SKOS defines it as symmetric, so the list reads the same from either
    concept. Whether a concept is a top concept is never edited here: the
    commands keep it (D-091), and the form only says so.

    A mapping points outside the project. Its target is typed as a link or
    picked from the concepts the document's imports define; the server
    checks it like any link, and it is shown as a link only when linkTarget
    lets it be one (D-088), otherwise as text.

INPUTS / INPUT SOURCES (props)
    - ontologyId, iri, name, model: the concept and its blocks.
    - runner: EditStructure's; onSelect: select a related concept.

EXPECTED OUTPUT
    - AddRelated, RemoveRelated, AddMapping and RemoveMapping through the
      runner; the markup.
================================================================================
*/

import { useId, useRef, useState } from "react";
import { linkTarget } from "../links";
import type { EntityModel } from "../modeling/entity";
import { MAPPINGS, topConceptSentence } from "../modeling/sentences";
import type { Runner } from "./EditParts";
import EntityPicker from "./EntityPicker";

interface Props {
  ontologyId: string;
  iri: string;
  name: string;
  model: EntityModel;
  runner: Runner;
  onSelect: (iri: string) => void;
}

const KIND_NAMES = Object.fromEntries(MAPPINGS.map((m) => [m.id, m.name]));

export default function ConceptRelations({ ontologyId, iri, name, model, runner, onSelect }: Props) {
  const { busy, errors, run, clear } = runner;
  const id = useId();
  const [open, setOpen] = useState<null | "related" | "mapping">(null);
  const [kind, setKind] = useState(MAPPINGS[0].id);
  const [target, setTarget] = useState("");
  const [picking, setPicking] = useState(false);
  const openers = useRef<Record<string, HTMLButtonElement | null>>({});

  const close = () => {
    const was = open;
    if (was) clear(was);
    setOpen(null);
    setTarget("");
    setPicking(false);
    if (was) window.setTimeout(() => openers.current[was]?.focus(), 0);
  };
  const opener = (which: "related" | "mapping", label: string) => (
    <button
      ref={(el) => {
        openers.current[which] = el;
      }}
      type="button"
      className="ghost"
      onClick={() => setOpen(which)}
    >
      {label}
    </button>
  );
  const addMapping = async (to: string) => {
    if (busy || !to.trim()) return;
    if (await run("mapping", "AddMapping", { concept: iri, kind, target: to.trim() })) close();
  };
  const means = MAPPINGS.find((m) => m.id === kind)?.means ?? "";

  return (
    <>
      {model.topOf.map((scheme) => (
        <p key={scheme.iri} className="detail-note concept-top">
          {topConceptSentence(scheme.label)}
        </p>
      ))}

      <h5>Related concepts</h5>
      {model.related.length === 0 ? (
        <p className="detail-note">No related concepts.</p>
      ) : (
        <ul className="edit-list">
          {model.related.map((r) => (
            <li key={r.iri}>
              <button type="button" className="term-link" title={r.iri} onClick={() => onSelect(r.iri)}>
                {r.label}
              </button>
              <button
                type="button"
                className="ghost edit-btn"
                aria-label={`Remove ${r.label} as related to ${name}`}
                aria-disabled={busy}
                onClick={() => !busy && void run("relatedList", "RemoveRelated", { concept: iri, related: r.iri })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {errors.relatedList && <p className="edit-error">{errors.relatedList}</p>}
      {open === "related" ? (
        <EntityPicker
          ontologyId={ontologyId}
          kind="concept"
          label={`Related to ${name}`}
          exclude={[iri, ...model.related.map((r) => r.iri)]}
          busy={busy}
          error={errors.related || null}
          onCancel={close}
          onPick={async (other) => {
            if (await run("related", "AddRelated", { concept: iri, related: other })) close();
          }}
        />
      ) : (
        opener("related", "Add related concept")
      )}

      <h5>Mappings</h5>
      {model.mappings.length === 0 ? (
        <p className="detail-note">No mappings to other vocabularies.</p>
      ) : (
        <ul className="edit-list">
          {model.mappings.map((m) => {
            const href = linkTarget(m.target.iri);
            return (
              <li key={`${m.kind}|${m.target.iri}`}>
                <span className="edit-annotation-property">{KIND_NAMES[m.kind] ?? m.kind}:</span>{" "}
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    {m.target.iri}
                  </a>
                ) : (
                  <span>{m.target.iri}</span>
                )}
                <button
                  type="button"
                  className="ghost edit-btn"
                  aria-label={`Remove the ${(KIND_NAMES[m.kind] ?? m.kind).toLowerCase()} ${m.target.iri}`}
                  aria-disabled={busy}
                  onClick={() =>
                    !busy && void run("mappingList", "RemoveMapping", { concept: iri, kind: m.kind, target: m.target.iri })
                  }
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {errors.mappingList && <p className="edit-error">{errors.mappingList}</p>}
      {open === "mapping" ? (
        <form
          className="new-entity-form"
          aria-label={`New mapping of ${name}`}
          onSubmit={(e) => {
            e.preventDefault();
            void addMapping(target);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !picking) {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        >
          <label className="edit-field-label" htmlFor={`${id}-kind`}>
            Kind of mapping
          </label>
          <select
            id={`${id}-kind`}
            value={kind}
            autoFocus
            aria-describedby={`${id}-means`}
            onChange={(e) => setKind(e.target.value)}
          >
            {MAPPINGS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} (skos:{m.id})
              </option>
            ))}
          </select>
          <p id={`${id}-means`} className="detail-note">
            {means}
          </p>
          {picking ? (
            <EntityPicker
              ontologyId={ontologyId}
              kind="concept"
              label="A concept from an import"
              exclude={[iri]}
              busy={busy}
              error={errors.mapping || null}
              onCancel={() => setPicking(false)}
              onPick={(picked) => void addMapping(picked)}
            />
          ) : (
            <>
              <label className="edit-field-label" htmlFor={`${id}-target`}>
                Link to the other concept
              </label>
              <input
                id={`${id}-target`}
                value={target}
                readOnly={busy}
                placeholder="http://dbpedia.org/resource/Apple"
                aria-invalid={errors.mapping ? true : undefined}
                onChange={(e) => setTarget(e.target.value)}
              />
              {errors.mapping && <p className="edit-error">{errors.mapping}</p>}
              <div className="edit-actions">
                <button type="submit" className="primary" aria-disabled={busy || !target.trim()}>
                  Add mapping
                </button>
                <button type="button" className="link-btn" onClick={() => setPicking(true)}>
                  or choose a concept from an import
                </button>
                <button type="button" className="ghost" onClick={close}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </form>
      ) : (
        opener("mapping", "Add mapping")
      )}
    </>
  );
}
