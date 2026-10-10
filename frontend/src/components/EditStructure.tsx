/*
================================================================================
FILE: frontend/src/components/EditStructure.tsx
================================================================================

SUMMARY
    The Structure block of the editing form (visual-modeling 5.1), one shape
    per kind of entity: a class's parents, subclasses, attributes and
    relationships; a concept's broader and narrower concepts, its scheme,
    and (ConceptRelations) its related concepts and mappings. A relationship
    or an attribute has a form of its own, RelationshipForm or AttributeForm
    (relationships 5.6, 5.7), which this hands over to. It is the form half
    of every canvas action's keyboard route (5.2, D-078). A class's rules
    (axioms-and-reasoning 5.9) are RulesBlock, between its kinds and its
    attributes and relationships.

BASIC IDEA
    Each list names what is there, as links that select it, with Remove where
    a command takes it away; each "Add …" opens either a picker (to link to
    something that exists) or the names-first form (to make something new).
    A new entity is selected once made, so the form moves to it.

    A relationship made here gets this class as its domain and, if one is
    chosen, a range, in one CreateObjectProperty: one undo step, as the canvas
    will make it.

INPUTS / INPUT SOURCES (props)
    - ontologyId, iri, name, model: the entity and its blocks.
    - primaryLanguage: for the names-first forms.
    - runner: EditSection's command runner, so busy and refusals are shared.
    - onSelect: select an entity; follow: select what a command made, unless
      the user went elsewhere while it ran (5.8 item 4).

    A closed form gives focus back to the button that opened it (5.8 item
    2). *Add relationship* waits for a range, as 5.1 says (item 10).

EXPECTED OUTPUT
    - Commands through the runner; the block's markup, a property's form, or
      nothing for a kind with no structure to edit.
================================================================================
*/

import { useRef, useState } from "react";
import { structureOf, type EntityModel, type Ref } from "../modeling/entity";
import type { ClassRules, ModelWarning, SearchKind } from "../types";
import AttributeForm from "./AttributeForm";
import ConceptRelations from "./ConceptRelations";
import { Block, type Runner } from "./EditParts";
import EntityPicker from "./EntityPicker";
import NewEntityForm from "./NewEntityForm";
import RelationshipForm from "./RelationshipForm";
import RulesBlock from "./RulesBlock";

interface Props {
  ontologyId: string;
  iri: string;
  name: string;
  model: EntityModel;
  primaryLanguage: string;
  runner: Runner;
  onSelect: (iri: string) => void;
  follow: (created: string | undefined) => void;
  /** A property's 5.9 warnings, shown under the block each concerns. */
  warnings?: ModelWarning[];
  /** A class's rules (axioms 5.9), shown between its kinds and its
   *  relationships. */
  rules?: ClassRules;
}

/** Which small form is open: at most one at a time. */
type Open =
  | null
  | "parent"
  | "subclass"
  | "attribute"
  | "relationship"
  | "broader"
  | "narrower";

function Links({
  refs,
  empty,
  onSelect,
  remove,
}: {
  refs: Ref[];
  empty: string;
  onSelect: (iri: string) => void;
  remove?: { label: (r: Ref) => string; run: (r: Ref) => void; busy: boolean };
}) {
  if (refs.length === 0) return <p className="detail-note">{empty}</p>;
  return (
    <ul className="edit-list">
      {refs.map((r) => (
        <li key={r.iri}>
          <button type="button" className="term-link" title={r.iri} onClick={() => onSelect(r.iri)}>
            {r.label}
          </button>
          {remove && (
            <button
              type="button"
              className="ghost edit-btn"
              aria-label={remove.label(r)}
              aria-disabled={remove.busy}
              onClick={() => !remove.busy && remove.run(r)}
            >
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

export default function EditStructure({
  ontologyId,
  iri,
  name,
  model,
  primaryLanguage,
  runner,
  onSelect,
  follow,
  warnings = [],
  rules,
}: Props) {
  const { busy, errors, run, clear } = runner;
  const [open, setOpen] = useState<Open>(null);
  // The button each form was opened from, to give focus back to.
  const openers = useRef<Record<string, HTMLButtonElement | null>>({});
  const [range, setRange] = useState<Ref | null>(null);
  const [pickingRange, setPickingRange] = useState(false);
  const shape = structureOf(model.kind);
  if (!shape) return null;

  const close = () => {
    const was = open;
    if (was) clear(was);
    setOpen(null);
    setRange(null);
    setPickingRange(false);
    if (was) window.setTimeout(() => openers.current[was]?.focus(), 0);
  };
  const button = (which: Open, label: string) => (
    <button
      ref={(el) => {
        if (which) openers.current[which] = el;
      }}
      type="button"
      className="ghost"
      onClick={() => setOpen(which)}
    >
      {label}
    </button>
  );
  const picker = (which: Open, kind: SearchKind, label: string, exclude: string[], onPick: (target: string) => Promise<unknown>) => (
    <EntityPicker
      ontologyId={ontologyId}
      kind={kind}
      label={label}
      exclude={[iri, ...exclude]}
      busy={busy}
      error={errors[which ?? ""] || null}
      onCancel={close}
      onPick={async (target) => {
        if (await onPick(target)) close();
      }}
    />
  );
  const create = async (which: string, command: string, args: Record<string, unknown>) => {
    const result = await run(which, command, args);
    if (result) {
      close();
      follow(result.created);
    }
  };

  if (shape === "class") {
    return (
      <Block title="Structure">
        <h5>Is a kind of</h5>
        <Links
          refs={model.parents}
          empty="No parent: a top-level class."
          onSelect={onSelect}
          remove={{
            busy,
            label: (r) => `Remove ${r.label} as a parent of ${name}`,
            run: (r) => void run("parents", "RemoveSubClassOf", { child: iri, parent: r.iri }),
          }}
        />
        {errors.parents && <p className="edit-error">{errors.parents}</p>}
        {open === "parent"
          ? picker("parent", "class", `New parent of ${name}`, model.parents.map((p) => p.iri), (parent) =>
              run("parent", "AddSubClassOf", { child: iri, parent }),
            )
          : button("parent", "Add parent")}

        <h5>Subclasses</h5>
        <Links refs={model.children} empty="No subclasses." onSelect={onSelect} />
        {open === "subclass" ? (
          <NewEntityForm
            title={`New subclass of ${name}`}
            primaryLanguage={primaryLanguage}
            busy={busy}
            error={errors.subclass}
            onCancel={close}
            onSubmit={({ name: label, iri: chosen }) =>
              void create("subclass", "CreateClass", { label, parent: iri, iri: chosen })
            }
          />
        ) : (
          button("subclass", "Add subclass")
        )}

        {rules && <RulesBlock iri={iri} name={name} rules={rules} runner={runner} onSelect={onSelect} />}

        <h5>Attributes</h5>
        <Links refs={model.attributes} empty="No attributes." onSelect={onSelect} />
        {open === "attribute" ? (
          <NewEntityForm
            title={`New attribute of ${name}`}
            primaryLanguage={primaryLanguage}
            datatypes
            busy={busy}
            error={errors.attribute}
            onCancel={close}
            onSubmit={({ name: label, iri: chosen, datatype }) =>
              void create("attribute", "CreateDatatypeProperty", { label, domain: iri, datatype, iri: chosen })
            }
          />
        ) : (
          button("attribute", "Add attribute")
        )}

        <h5>Relationships</h5>
        <Links refs={model.relationships} empty="No relationships." onSelect={onSelect} />
        {open === "relationship" ? (
          <NewEntityForm
            title={`New relationship from ${name}`}
            primaryLanguage={primaryLanguage}
            busy={busy}
            error={errors.relationship}
            missing={range ? null : "Choose the class it points to."}
            onCancel={close}
            onSubmit={({ name: label, iri: chosen }) =>
              range && void create("relationship", "CreateObjectProperty", {
                label,
                domain: iri,
                range: range.iri,
                iri: chosen,
              })
            }
          >
            <div className="edit-range">
              {pickingRange ? (
                <EntityPicker
                  ontologyId={ontologyId}
                  kind="class"
                  label="It points to (a class)"
                  onCancel={() => setPickingRange(false)}
                  onPick={(target, label) => {
                    setRange({ iri: target, label });
                    setPickingRange(false);
                  }}
                />
              ) : (
                <p className="detail-note">
                  It points to: {range ? range.label : "not chosen yet (required)"}{" "}
                  <button type="button" className="link-btn" onClick={() => setPickingRange(true)}>
                    {range ? "Change" : "Choose a class"}
                  </button>
                </p>
              )}
            </div>
          </NewEntityForm>
        ) : (
          button("relationship", "Add relationship")
        )}
      </Block>
    );
  }

  if (shape === "property") {
    // Relationships Stage B: each kind of property has its own form (5.6, 5.7).
    return model.kind === "datatypeProperty" ? (
      <AttributeForm
        ontologyId={ontologyId}
        iri={iri}
        name={name}
        model={model}
        runner={runner}
        onSelect={onSelect}
        warnings={warnings}
      />
    ) : (
      <RelationshipForm
        ontologyId={ontologyId}
        iri={iri}
        name={name}
        model={model}
        primaryLanguage={primaryLanguage}
        runner={runner}
        onSelect={onSelect}
        warnings={warnings}
      />
    );
  }

  return (
    <Block title="Structure">
      <h5>Broader concepts</h5>
      <Links
        refs={model.broader}
        empty="No broader concept: a top concept."
        onSelect={onSelect}
        remove={{
          busy,
          label: (r) => `Remove ${r.label} as broader than ${name}`,
          run: (r) => void run("broaderList", "RemoveBroader", { concept: iri, broader: r.iri }),
        }}
      />
      {errors.broaderList && <p className="edit-error">{errors.broaderList}</p>}
      {open === "broader"
        ? picker("broader", "concept", `New broader concept of ${name}`, model.broader.map((b) => b.iri), (broader) =>
            run("broader", "AddBroader", { concept: iri, broader }),
          )
        : button("broader", "Add broader concept")}

      <h5>Narrower concepts</h5>
      <Links refs={model.narrower} empty="No narrower concepts." onSelect={onSelect} />
      {open === "narrower" ? (
        <NewEntityForm
          title={`New narrower concept of ${name}`}
          primaryLanguage={primaryLanguage}
          busy={busy}
          error={errors.narrower}
          onCancel={close}
          onSubmit={({ name: label, iri: chosen }) =>
            void create("narrower", "CreateConcept", { prefLabel: label, broader: iri, iri: chosen })
          }
        />
      ) : (
        button("narrower", "Add narrower concept")
      )}

      {model.schemes.length > 0 && (
        <>
          <h5>Scheme</h5>
          <Links refs={model.schemes} empty="" onSelect={onSelect} />
        </>
      )}

      <ConceptRelations ontologyId={ontologyId} iri={iri} name={name} model={model} runner={runner} onSelect={onSelect} />
    </Block>
  );
}
