/*
================================================================================
FILE: frontend/src/components/PathBar.tsx
================================================================================

SUMMARY
    The chip bar at the top of the query panel showing the query PATH: numbered
    class chips with predicate chips between them, plus per-step remove and a
    clear-all. Clicking a chip opens its menu (class -> properties; predicate ->
    relationship options).

BASIC IDEA
    Purely presentational over the QueryState. It signals which chip's menu
    should open (via onOpenMenu / the OpenMenu type), shows branch markers (dN)
    when a hop attaches to an earlier step, pins, and property counts. The
    actual menus and edits live in sibling components / the hook.

INPUTS / INPUT SOURCES (props)
    - state + stepVars: the path to render and its variable names.
    - theme, classKinds, labelFor: for colours and labels.
    - openMenu + onOpenMenu: which chip's menu is open.
    - onRemoveStep, onClear: edit actions.

EXPECTED OUTPUT
    - The rendered path bar; menu-open and edit callbacks.
================================================================================
*/

import type { QueryState } from "../sparql/types";
import type { Theme } from "../types";
import { kindColor } from "../types";

// Identifies which chip's popover menu is open: a class chip or a predicate chip.
export interface OpenMenu {
  kind: "class" | "link";
  index: number;
}

interface Props {
  state: QueryState;
  stepVars: string[];
  theme: Theme;
  classKinds: Record<string, string>;
  labelFor: (iri: string) => string;
  openMenu: OpenMenu | null;
  onOpenMenu: (menu: OpenMenu | null) => void;
  onRemoveStep: (index: number) => void;
  onClear: () => void;
}

export default function PathBar({
  state,
  stepVars,
  theme,
  classKinds,
  labelFor,
  openMenu,
  onOpenMenu,
  onRemoveStep,
  onClear,
}: Props) {
  if (state.steps.length === 0) {
    return (
      <div className="path-bar empty">
        <span className="path-label">PATH</span>
        <span className="hint">Nothing selected yet — click a highlighted node in the graph.</span>
      </div>
    );
  }

  return (
    <div className="path-bar">
      <span className="path-label">PATH</span>
      {state.steps.map((step, index) => {
        const link = step.link;
        const isOpenClass = openMenu?.kind === "class" && openMenu.index === index;
        const isOpenLink = openMenu?.kind === "link" && openMenu.index === index;
        const predicateText = link
          ? link.predicates
              .map((p) => `${p.inverse ? "^" : ""}${labelFor(p.iri)}`)
              .join(" | ") + (link.modifier || "")
          : "";
        const branched = link && link.anchor !== index - 1;
        return (
          <span className="path-group" key={index}>
            {link && (
              <>
                <span className="path-arrow">→</span>
                <button
                  className={[
                    "chip chip-pred",
                    link.optional ? "optional" : "",
                    isOpenLink ? "open" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => onOpenMenu(isOpenLink ? null : { kind: "link", index })}
                  title={
                    `Relationship from step ${link.anchor + 1}. ` +
                    "Click to change direction, add alternatives, set a path modifier or make it optional."
                  }
                >
                  {branched && <span className="chip-branch">↳{link.anchor + 1}</span>}
                  {predicateText}
                  {link.optional && <span className="chip-flag">opt</span>}
                </button>
                <span className="path-arrow">→</span>
              </>
            )}
            <button
              className={["chip chip-class", isOpenClass ? "open" : ""].filter(Boolean).join(" ")}
              onClick={() => onOpenMenu(isOpenClass ? null : { kind: "class", index })}
              title={`?${stepVars[index]} — click to select data properties and filters`}
              style={{
                borderColor: kindColor(classKinds[step.classIri] ?? "class", theme),
              }}
            >
              <span
                className="chip-index"
                style={{ background: kindColor(classKinds[step.classIri] ?? "class", theme) }}
              >
                {index + 1}
              </span>
              {step.label}
              {step.pin && (
                <span className="chip-flag pin" title={`Pinned to ${step.pin.label}`}>
                  ⚲ {step.pin.label}
                </span>
              )}
              {step.props.length > 0 && (
                <span className="chip-count" title={`${step.props.length} data properties`}>
                  {step.props.length}
                </span>
              )}
            </button>
            <button
              className="chip-remove"
              title="Remove this step and everything after it"
              onClick={() => onRemoveStep(index)}
            >
              ✕
            </button>
          </span>
        );
      })}
      <button className="chip chip-clear" onClick={onClear} title="Clear the whole path">
        ✕ Clear path
      </button>
    </div>
  );
}
