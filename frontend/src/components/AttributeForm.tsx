/*
================================================================================
FILE: frontend/src/components/AttributeForm.tsx
================================================================================

SUMMARY
    The attribute form of relationships-and-project-kinds 5.7, for a datatype
    property of the open project's model: *Belongs to* (its domain, changed
    or cleared), *Type of value* (one of the seven types of E-6), and **One
    value only**, with its example in the attribute's own names. The sentence
    at the top is RelationshipForm's PropertyHead; a warning is shown under
    *How many values* by its Warnings, and the checkbox is aria-disabled
    while a change is saving.

BASIC IDEA
    The same shape as the relationship form, smaller: every control is one
    command through EditSection's runner. The type is chosen in a list and
    set with a button rather than on change, because a closed list changes
    on every arrow key in some browsers, and each change would be an undo
    step of its own. *One value only* is owl:FunctionalProperty, the one
    characteristic an attribute takes (5.7); the server refuses the others.

INPUTS / INPUT SOURCES (props)
    - ontologyId, iri, name, model: the attribute and its blocks.
    - runner: EditSection's; onSelect: select the class it belongs to.

EXPECTED OUTPUT
    - SetDomain, ClearDomain, SetRange and SetCharacteristic through the
      runner; the blocks' markup.
================================================================================
*/

import { useId, useRef, useState } from "react";
import type { EntityModel } from "../modeling/entity";
import { oneValueExample, typeWord } from "../modeling/sentences";
import { DATATYPES } from "../modeling/values";
import { Block, type Runner } from "./EditParts";
import EntityPicker from "./EntityPicker";
import { datatypeOf, Warnings } from "./RelationshipForm";
import type { ModelWarning } from "../types";

interface Props {
  ontologyId: string;
  iri: string;
  name: string;
  model: EntityModel;
  runner: Runner;
  onSelect: (iri: string) => void;
  warnings?: ModelWarning[];
}

export default function AttributeForm({ ontologyId, iri, name, model, runner, onSelect, warnings = [] }: Props) {
  const { busy, errors, run, clear } = runner;
  const id = useId();
  const [open, setOpen] = useState<null | "domain" | "type">(null);
  const openers = useRef<Record<string, HTMLButtonElement | null>>({});
  const datatype = datatypeOf(model.range);
  const domain = model.domain;

  const close = () => {
    const was = open;
    if (was) clear(was);
    setOpen(null);
    if (was) window.setTimeout(() => openers.current[was]?.focus(), 0);
  };
  const opener = (which: "domain" | "type", label: string, aria: string) => (
    <button
      ref={(el) => {
        openers.current[which] = el;
      }}
      type="button"
      className="ghost"
      aria-label={aria}
      onClick={() => setOpen(which)}
    >
      {label}
    </button>
  );

  return (
    <>
      <Block title="Belongs to">
        {domain ? (
          <p className="edit-value">
            <button type="button" className="term-link" title={domain.iri} onClick={() => onSelect(domain.iri)}>
              {domain.label}
            </button>
            <button
              type="button"
              className="ghost edit-btn"
              aria-label={`Clear the class ${name} belongs to`}
              aria-disabled={busy}
              onClick={() => !busy && void run("domainList", "ClearDomain", { property: iri })}
            >
              Clear
            </button>
          </p>
        ) : (
          <p className="detail-note">No class yet.</p>
        )}
        {errors.domainList && <p className="edit-error">{errors.domainList}</p>}
        {open === "domain" ? (
          <EntityPicker
            ontologyId={ontologyId}
            kind="class"
            label={`The class ${name} belongs to`}
            exclude={domain ? [domain.iri] : []}
            busy={busy}
            error={errors.domain || null}
            onCancel={close}
            onPick={async (target) => {
              if (await run("domain", "SetDomain", { property: iri, target })) close();
            }}
          />
        ) : (
          opener("domain", domain ? "Change class" : "Choose a class", `${domain ? "Change" : "Choose"} the class ${name} belongs to`)
        )}
      </Block>

      <Block title="Type of value">
        <p className={datatype ? undefined : "detail-name-missing"}>
          {typeWord(datatype)}
          {datatype && <span className="owl-term"> {datatype}</span>}
        </p>
        {open === "type" ? (
          <form
            className="edit-range"
            onSubmit={async (e) => {
              e.preventDefault();
              // aria-disabled does not stop a second Enter (found in review).
              if (busy) return;
              const target = new FormData(e.currentTarget).get("datatype");
              if (await run("type", "SetRange", { property: iri, target })) close();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          >
            <label className="edit-field-label" htmlFor={`${id}-type`}>
              Type of value
            </label>
            <select
              id={`${id}-type`}
              name="datatype"
              autoFocus
              defaultValue={datatype?.startsWith("xsd:") ? datatype : "xsd:string"}
            >
              {DATATYPES.map((d) => (
                <option key={d} value={`xsd:${d}`}>
                  {typeWord(`xsd:${d}`)} (xsd:{d})
                </option>
              ))}
            </select>
            {errors.type && <p className="edit-error">{errors.type}</p>}
            <div className="edit-actions">
              <button type="submit" className="primary" aria-disabled={busy}>
                Set type
              </button>
              <button type="button" className="ghost" onClick={close}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          opener("type", "Change type", `Change the type of value of ${name}`)
        )}
      </Block>

      <Block title="How many values">
        <label className="characteristic">
          <input
            type="checkbox"
            checked={model.characteristics.has("functional")}
            aria-describedby={`${id}-one`}
            // A click while a change saves would be dropped; say so (v0.6).
            aria-disabled={busy}
            onChange={(e) =>
              !busy &&
              void run("functional", "SetCharacteristic", { property: iri, characteristic: "functional", on: e.target.checked })
            }
          />{" "}
          One value only <span className="owl-term">owl:FunctionalProperty</span>
        </label>
        <p id={`${id}-one`} className="characteristic-example">
          {oneValueExample(domain?.label ?? null, name)}
        </p>
        <Warnings warnings={warnings} block="characteristics" runner={runner} />
        {errors.functional && (
          <p className="edit-error" role="alert">
            {errors.functional}
          </p>
        )}
      </Block>
    </>
  );
}
