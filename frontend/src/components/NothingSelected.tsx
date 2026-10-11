/*
================================================================================
FILE: frontend/src/components/NothingSelected.tsx
================================================================================

SUMMARY
    The side panel's Details tab with nothing selected (edit-page-rework
    5.4): *Nothing selected*, how to select, a *This model* summary in
    counts, and **New class** (**New concept** in a taxonomy) -- the third
    place a newcomer looks for how to make something (Section 7).

BASIC IDEA
    Counts, not a list: the outline beside it is the list. They come from
    the outline's own fetch (HierarchyView's onCounts), so this costs no
    request. The button starts the one draft (5.5) and is handed to the
    store as where the creation began, so Cancel gives focus back to it.

INPUTS / INPUT SOURCES (props)
    - counts: the model's classes or concepts, relationships, attributes
      and examples; null while the outline is loading.
    - taxonomy: a taxonomy's words, and New concept.

EXPECTED OUTPUT
    - The panel's content; projectStore.startCreating on the button.
================================================================================
*/

import { projectStore } from "../state/projectStore";

export interface ModelCounts {
  classes: number;
  concepts: number;
  relationships: number;
  attributes: number;
  examples: number;
}

interface Props {
  counts: ModelCounts | null;
  taxonomy: boolean;
}

/** "1 class", "3 classes". */
function counted(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

export default function NothingSelected({ counts, taxonomy }: Props) {
  const lines = counts
    ? taxonomy
      ? [counted(counts.concepts, "concept", "concepts")]
      : [
          counted(counts.classes, "class", "classes"),
          counted(counts.relationships, "relationship", "relationships"),
          counted(counts.attributes, "attribute", "attributes"),
          counted(counts.examples, "example", "examples"),
        ]
    : [];
  return (
    <div className="nothing-selected">
      <h2 className="side-heading">Nothing selected</h2>
      <p className="detail-note">
        Select a {taxonomy ? "concept" : "class"} in the outline or on the canvas to see its details and change it.
      </p>
      <h3 className="side-subheading">This model</h3>
      {counts ? (
        <ul className="model-counts">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="detail-note">Counting…</p>
      )}
      <button
        type="button"
        className="primary"
        // Its name for focus coming back: the form replaces this button
        // while the draft is open (projectStore's creationStart).
        data-create-from="side-panel-new"
        onClick={(e) => projectStore.startCreating(taxonomy ? "concept" : "class", { from: e.currentTarget })}
      >
        <span aria-hidden="true">+ </span>
        {taxonomy ? "New concept" : "New class"}
      </button>
    </div>
  );
}
