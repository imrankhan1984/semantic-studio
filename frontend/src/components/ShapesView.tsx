/*
================================================================================
FILE: frontend/src/components/ShapesView.tsx
================================================================================

SUMMARY
    The Shapes view of a project (shacl-authoring 5.1, 5.2), in two columns
    (load-and-shapes 5.3): on the left the list of shapes, each a short
    sentence with its last result as a word and a coloured dot, with
    Validate and + at its head; on the right one panel with two tabs, Shape
    (the selected shape's form) and Results (the result panels).

BASIC IDEA
    One shape at a time, as Imran asked (D-093). + opens a short chooser --
    *Rules for a class* in an ontology, *Rules for concepts* in a taxonomy,
    and *Check my model* in both -- and the shape it creates opens in the
    form and is selected in the list; nothing else opens with it. The first
    + makes shapes.ttl on the server, and the store then tracks it.

    The list is the server's reading of shapes.ttl (getShapes), fetched
    again whenever either document's revision moves, so a shape written in
    the Turtle editor appears here as it would after a form edit, read-only
    when the form cannot edit it (5.5). Each row's result comes from the
    last validation in the project store, said as a word beside its dot
    (never colour alone), and marked stale when either document changed
    since.

    A shape written as a blank node gets a new id with every Turtle apply;
    the view finds it again by its name and target, so it stays selected
    (Stage B follow-up 8).

    The list is a set of buttons with aria-pressed rather than a listbox:
    each row is one action (open this shape), and a keyboard user reaches it
    with Tab like every other control in the panel.

    Validate heads the list because validating is what the whole list is
    for, and it stays in sight on both tabs. The panel is SideTabs, the Edit
    page's frame given its own two names: a run starting, from the button or
    from the data wizard's next step, shows Results; a new result arriving while
    Shape is showing (the person moved back) puts the problems found on the
    Results tab, in words and in its name, as Reasoning does. On arrival the
    first shape is selected, without moving focus, so the panel opens on a
    form rather than on *Choose a shape*; only arrival does this, since a
    delete clears the selection on purpose. Choosing or making a shape
    shows Shape; the form stays mounted, hidden, under Results, so a rule
    open in it keeps its edits through a run.

INPUTS / INPUT SOURCES (props)
    - projectId, kind, languages, modelOntologyId, revisions.
    - onSelectEntity: a problem's link (App selects the individual).
    - onEditInTurtle: open the editor at a read-only shape.
    - onError: App's error bar.

EXPECTED OUTPUT
    - The view; shape commands and validation through the project store.
================================================================================
*/

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { getShapes } from "../api";
import { STATE_WORDS, problemsFound, rowSentence } from "../modeling/shapeSentences";
import { projectStore, useProjectSelector } from "../state/projectStore";
import type { PanelState, ProjectKind, ShapeForm as Shape, ShapesListing } from "../types";
import { useRunner, useReturnFocus } from "./EditParts";
import EntityPicker from "./EntityPicker";
import ResultPanels, { ValidateButton, isStale } from "./ResultPanels";
import ShapeForm from "./ShapeForm";
import SideTabs, { type TabSpec } from "./SideTabs";

const SKOS_CONCEPT = "http://www.w3.org/2004/02/skos/core#Concept";

type ShapesTab = "shape" | "results";

interface Props {
  projectId: string;
  kind: ProjectKind | null;
  languages: string[];
  modelOntologyId: string;
  onSelectEntity: (iri: string) => void;
  onEditInTurtle: (shape: Shape) => void;
  onError: (message: string) => void;
}

export default function ShapesView({
  projectId,
  kind,
  languages,
  modelOntologyId,
  onSelectEntity,
  onEditInTurtle,
  onError,
}: Props) {
  const documents = useProjectSelector((s) => s.documents);
  const validation = useProjectSelector((s) => s.validation);
  const validating = useProjectSelector((s) => s.validating);
  const modelRevision = documents.find((d) => d.doc === "model")?.revision ?? 0;
  const shapesRevision = documents.find((d) => d.doc === "shapes")?.revision ?? null;
  const revisions = `${modelRevision}|${shapesRevision}`;
  const [listing, setListing] = useState<ShapesListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<null | "menu" | "class">(null);
  const runner = useRunner("shapes");
  const [plusRef, restorePlus] = useReturnFocus();
  const menuId = useId();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    getShapes(projectId)
      .then((l) => {
        if (!live) return;
        setListing(l);
        setListError(null);
      })
      .catch((e: unknown) => live && setListError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [projectId, revisions]);

  const shapes = listing?.shapes ?? [];
  // The selection is kept by id even while the list does not hold it: an
  // undo of the create takes the shape away and the redo brings it back to
  // the same form; a list still on its way after a create would otherwise
  // drop the shape just made (both found in the Chrome pass). Delete clears
  // it on purpose.
  const selected = shapes.find((s) => s.id === selectedId) ?? null;
  // A shape written as a blank node has a new _: id after every Turtle
  // apply, which re-parses the document. It is found again by what it is --
  // its name and target, and no IRI -- when exactly one shape matches
  // (Stage A follow-up 8); an IRI keeps its id and needs none of this.
  const lastSelected = useRef<Shape | null>(null);
  if (selected) lastSelected.current = selected;
  useEffect(() => {
    const was = lastSelected.current;
    if (!listing || selected || !selectedId?.startsWith("_:") || was?.id !== selectedId) return;
    const same = listing.shapes.filter(
      (s) => s.iri === null && s.name === was.name && s.target?.iri === was.target?.iri,
    );
    if (same.length === 1) setSelectedId(same[0].id);
  }, [listing, selected, selectedId]);
  // A shape just made takes focus once its form is drawn, which is after
  // the list holding it arrives, not when the command answers.
  const [focusFor, setFocusFor] = useState<string | null>(null);
  useEffect(() => {
    if (focusFor === null || selected?.id !== focusFor) return;
    document.getElementById("shape-form-heading")?.focus();
    setFocusFor(null);
  }, [focusFor, selected]);

  useEffect(() => {
    if (choosing === "menu") menuRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [choosing]);

  // Arrival: the first shape, once, and focus stays where it is.
  const arrivedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!listing || arrivedFor.current === projectId) return;
    arrivedFor.current = projectId;
    if (selectedId === null && listing.shapes.length > 0) setSelectedId(listing.shapes[0].id);
  }, [listing, projectId, selectedId]);

  // Arriving during a run -- the data wizard's *Validate* starts one as it
  // opens this view -- is arriving at its results.
  const [tab, setTab] = useState<ShapesTab>(() => (projectStore.getSnapshot().validating ? "results" : "shape"));
  const tabNow = useRef(tab);
  tabNow.current = tab;
  const [resultsBadge, setResultsBadge] = useState<string | null>(null);
  const chooseTab = useCallback((next: ShapesTab) => {
    setTab(next);
    if (next === "results") setResultsBadge(null);
  }, []);
  // A run's end is a new result, which marks the tab if Shape is showing. A
  // failed run leaves the old result in place and marks nothing. Watched by
  // the result, not the running flag: a quick run can start and end within
  // one render, and the flag is then never seen true.
  const lastResult = useRef(validation);
  useEffect(() => {
    if (validation === lastResult.current) return;
    lastResult.current = validation;
    if (validation && tabNow.current !== "results") setResultsBadge(problemsFound(validation));
  }, [validation]);
  const tabs: TabSpec<ShapesTab>[] = [
    { id: "shape", name: "Shape" },
    { id: "results", name: "Results", badge: resultsBadge ? { shown: resultsBadge, spoken: resultsBadge } : null },
  ];

  const create = useCallback(
    async (args: Record<string, unknown>) => {
      const result = await runner.run("create", "CreateShape", args);
      setChoosing(null);
      if (result?.created) {
        // Its form is where focus goes, so Shape must be the tab showing.
        setSelectedId(result.created);
        chooseTab("shape");
        setFocusFor(result.created);
      } else restorePlus();
    },
    [runner, restorePlus, chooseTab],
  );

  const stale = isStale(validation, documents);
  const resultOf = (id: string): PanelState | null =>
    validation?.shapes.find((p) => p.id === id)?.state ?? null;

  return (
    <section className="shapes-view" aria-labelledby="shapes-view-heading">
      <div className="shapes-list">
        <div className="shapes-list-head">
          <h2 id="shapes-view-heading" tabIndex={-1}>
            Shapes
          </h2>
          <ValidateButton onError={onError} onStart={() => chooseTab("results")} />
          <button
            ref={plusRef}
            type="button"
            className="primary shapes-add"
            aria-label="Add a shape"
            aria-expanded={choosing === "menu"}
            aria-controls={menuId}
            title="Add rules for a class, or check your model"
            onClick={() => setChoosing((c) => (c === "menu" ? null : "menu"))}
          >
            +
          </button>
        </div>
        <div
          id={menuId}
          ref={menuRef}
          className="shapes-chooser"
          hidden={choosing !== "menu"}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setChoosing(null);
              restorePlus();
            }
          }}
        >
          {choosing === "menu" && (
            <>
              {kind === "taxonomy" ? (
                <button type="button" className="ghost" onClick={() => void create({ target: SKOS_CONCEPT })}>
                  Rules for concepts
                </button>
              ) : (
                <button type="button" className="ghost" onClick={() => setChoosing("class")}>
                  Rules for a class
                </button>
              )}
              <button type="button" className="ghost" onClick={() => void create({ preset: "modelCheck" })}>
                Check my model
              </button>
            </>
          )}
        </div>
        {choosing === "class" && (
          <EntityPicker
            ontologyId={modelOntologyId}
            kind="class"
            label="Rules for which class?"
            busy={runner.busy}
            error={runner.errors.create}
            onPick={(iri) => void create({ target: iri })}
            onCancel={() => {
              setChoosing(null);
              restorePlus();
            }}
          />
        )}
        {choosing === null && runner.errors.create && <p className="edit-error">{runner.errors.create}</p>}
        {listError && <p className="edit-error">{listError}</p>}
        {listing && shapes.length === 0 ? (
          <p className="detail-note">No shapes yet. Press + to add rules for a class, or check your model.</p>
        ) : (
          <ul className="shapes-rows">
            {shapes.map((shape) => {
              const state = resultOf(shape.id);
              const word = state ? STATE_WORDS[state] : "Not checked";
              return (
                <li key={shape.id}>
                  <button
                    type="button"
                    className={shape.id === selected?.id ? "shapes-row selected" : "shapes-row"}
                    aria-pressed={shape.id === selected?.id}
                    onClick={() => {
                      setSelectedId(shape.id);
                      chooseTab("shape");
                    }}
                  >
                    <span className="shapes-row-name">{shape.name}</span>
                    <span className="shapes-row-sentence">{rowSentence(shape)}</span>
                    <span className={`shapes-row-result result-dot-${state ?? "none"}`}>
                      <span className="result-dot" aria-hidden="true" />
                      {word}
                      {state && stale ? " (stale)" : ""}
                      {!shape.editable ? " · Turtle" : ""}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <SideTabs<ShapesTab>
        tab={tab}
        onTab={chooseTab}
        tabs={tabs}
        label="Shape and results"
        className="side-panel shapes-panel"
      >
        {/* Shape stays mounted while Results shows: Validate switches tabs,
            and a rule open in the form would otherwise lose its edits. */}
        <div className="shapes-form-column" hidden={tab !== "shape"}>
            {selected ? (
              <ShapeForm
                key={selected.id}
                projectId={projectId}
                shape={selected}
                modelOntologyId={modelOntologyId}
                languages={languages}
                revisions={revisions}
                onDeleted={() => {
                  setSelectedId(null);
                  window.setTimeout(() => document.getElementById("shapes-view-heading")?.focus(), 0);
                }}
                onEditInTurtle={onEditInTurtle}
              />
            ) : (
              <p className="detail-note shapes-form-empty">
                {shapes.length ? "Choose a shape to see its rules." : "A shape says what good data looks like: every Person has a name, for example."}
              </p>
            )}
          </div>
        {tab === "results" && (
          <div className="shapes-results">
            {/* Seen, not announced: the store's live region says Validating…
                and the summary. */}
            {validating && <p className="detail-note results-progress">Checking the model against every shape…</p>}
            <ResultPanels onSelect={onSelectEntity} />
          </div>
        )}
      </SideTabs>
    </section>
  );
}
