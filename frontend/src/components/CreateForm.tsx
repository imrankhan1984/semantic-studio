/*
================================================================================
FILE: frontend/src/components/CreateForm.tsx
================================================================================

SUMMARY
    The side panel's New … form (edit-page-rework 5.4, 5.5): a new class or
    concept (name, *kind of* or *narrower than*, an optional definition), a
    relationship (name, from, to), an attribute (name, belongs to, type of
    value) or an example (name, example of). Whatever route began it -- the
    canvas palette, a drop on a box, an outline section's +, a row's *Add
    subclass*, or the panel's own button -- this is the one form.

BASIC IDEA
    The draft lives in the project store, not here: a class's name is the
    canvas draft box's name too, so typing in either shows in both, and
    Enter in either makes it. Creating is the store's one command; a refusal
    is the store's sentence, under this name field and the box's alike.

    So does everything else the form holds -- the definition, the ends or
    class chosen, More options -- so Enter in the canvas's box makes the same
    thing Create here would (code review).

    Focus: the name field takes it when the form opens unless the canvas's
    draft box has it already (`focusName`). Cancel, Esc, or focus leaving
    both empty fields ends the draft, and the store gives focus back to the
    control the creation began from. Nothing here is `disabled`: Create is
    aria-disabled while the name is empty (NewEntityForm).

INPUTS / INPUT SOURCES (props)
    - ontologyId: the model, for the pickers' searches.
    - primaryLanguage: the language a name is written in.
    - focusName: take focus on open (false when the canvas box has it).
    Plus the project store's `creating`, `creatingBusy`, `creatingError`.

EXPECTED OUTPUT
    - The form; projectStore.createDraft or cancelCreating.
================================================================================
*/

import { useState } from "react";
import { projectStore, useProjectSelector, type Creating } from "../state/projectStore";
import type { CreatingKind } from "../types";
import EntityPicker from "./EntityPicker";
import NewEntityForm from "./NewEntityForm";

interface Props {
  ontologyId: string;
  primaryLanguage: string;
  focusName?: boolean;
}

interface Pick {
  iri: string;
  label: string;
}

/** The form's title, which names what is being made (5.5). */
export function creatingTitle(kind: CreatingKind, parent: Pick | null): string {
  switch (kind) {
    case "class":
      return parent ? `New kind of ${parent.label}` : "New class";
    case "concept":
      return parent ? `New concept narrower than ${parent.label}` : "New concept";
    case "objectProperty":
      return "New relationship";
    case "datatypeProperty":
      return "New attribute";
    case "example":
      return "New example";
  }
}

/** True when focus has gone to one of the two places a draft is named. */
export function intoDraft(to: EventTarget | null): boolean {
  return to instanceof Element && to.closest(".canvas-draft, .create-form") !== null;
}

export default function CreateForm(props: Props) {
  const creating = useProjectSelector((s) => s.creating);
  // A new draft is a new form: its choices start empty.
  return creating ? <DraftForm key={creating.token} {...props} creating={creating} /> : null;
}

function DraftForm({ ontologyId, primaryLanguage, focusName = true, creating }: Props & { creating: Creating }) {
  const busy = useProjectSelector((s) => s.creatingBusy);
  const error = useProjectSelector((s) => s.creatingError);
  // Shown here; what is made is the store's copy (setCreatingExtra).
  const [definition, setDefinition] = useState("");
  const [domain, setDomainShown] = useState<Pick | null>(null);
  const [range, setRangeShown] = useState<Pick | null>(null);
  const [cls, setClsShown] = useState<Pick | null>(null);
  const setDomain = (p: Pick | null) => {
    setDomainShown(p);
    projectStore.setCreatingExtra({ domain: p?.iri });
  };
  const setRange = (p: Pick | null) => {
    setRangeShown(p);
    projectStore.setCreatingExtra({ range: p?.iri });
  };
  const setCls = (p: Pick | null) => {
    setClsShown(p);
    projectStore.setCreatingExtra({ cls: p?.iri });
  };
  const [picking, setPicking] = useState<null | "parent" | "domain" | "range" | "cls">(null);
  const { kind, parent } = creating;
  const box = kind === "class" || kind === "concept";

  const picker = (label: string, onPick: (p: Pick) => void) => (
    <EntityPicker
      ontologyId={ontologyId}
      kind={kind === "concept" ? "concept" : "class"}
      label={label}
      onCancel={() => setPicking(null)}
      onPick={(iri, name) => {
        onPick({ iri, label: name });
        setPicking(null);
      }}
    />
  );
  /** One optional or required choice: what it is now, and Choose or Change. */
  const choice = (which: NonNullable<typeof picking>, words: string, value: Pick | null, set: (p: Pick | null) => void, required = false) =>
    picking === which ? (
      picker(words, set)
    ) : (
      <p className="detail-note create-choice">
        {words}: {value ? value.label : required ? "not chosen yet (required)" : "none"}{" "}
        <button type="button" className="link-btn" onClick={() => setPicking(which)}>
          {value ? "Change" : "Choose"}
        </button>
        {value && !required && (
          <button type="button" className="link-btn" onClick={() => set(null)}>
            Clear
          </button>
        )}
      </p>
    );

  // What Create waits for, said beside it: as the class form's relationship
  // waits for the class it points to (visual-modeling 5.8 item 10).
  const missing =
    kind === "example" && !cls
      ? "Choose the class it is an example of."
      : kind === "objectProperty" && !range
        ? "Choose the class it points to."
        : null;

  return (
    <div className="create-form">
      <NewEntityForm
        title={creatingTitle(kind, parent)}
        primaryLanguage={primaryLanguage}
        busy={busy}
        error={error}
        missing={missing}
        datatypes={kind === "datatypeProperty"}
        name={creating.name}
        onNameChange={(name) => projectStore.setCreatingName(name)}
        focusName={focusName}
        onNameBlur={(to) => {
          // Focus leaving both fields empty ends the draft (5.5); it has gone
          // somewhere on purpose, so it is not pulled back.
          if (!busy && !projectStore.getSnapshot().creating?.name.trim() && to !== null && !intoDraft(to)) {
            projectStore.cancelCreating(false);
          }
        }}
        onCancel={() => projectStore.cancelCreating()}
        onMoreChange={(more) => projectStore.setCreatingExtra(more)}
        onSubmit={() => void projectStore.createDraft()}
      >
        {box &&
          choice(
            "parent",
            kind === "class" ? "Kind of" : "Narrower than",
            parent,
            (p) => projectStore.setCreatingParent(p),
          )}
        {box && (
          <>
            <label className="edit-field-label" htmlFor="create-definition">
              Definition (optional)
            </label>
            <textarea
              id="create-definition"
              rows={2}
              value={definition}
              readOnly={busy}
              onChange={(e) => {
                setDefinition(e.target.value);
                projectStore.setCreatingExtra({ definition: e.target.value });
              }}
            />
          </>
        )}
        {(kind === "objectProperty" || kind === "datatypeProperty") &&
          choice("domain", kind === "objectProperty" ? "From" : "Belongs to", domain, setDomain)}
        {kind === "objectProperty" && choice("range", "To", range, setRange, true)}
        {kind === "example" && choice("cls", "Example of", cls, setCls, true)}
      </NewEntityForm>
    </div>
  );
}
