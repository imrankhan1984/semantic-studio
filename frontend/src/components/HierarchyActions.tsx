/*
================================================================================
FILE: frontend/src/components/HierarchyActions.tsx
================================================================================

SUMMARY
    The Hierarchy tree's row menu in a project (visual-modeling 5.2): "More
    actions for Invoice", with Add subclass or Add narrower concept, Rename,
    and Delete…. Also the rule for which of those a row offers.

BASIC IDEA
    A menu by the WAI-ARIA menu-button pattern. It opens from the row's "⋯"
    button or, on the focused row, from the Context Menu key or Shift+F10 --
    the row is a treeitem and its button is out of the tab order, so the
    keyboard needs a key of its own, and those two are what a desktop user
    already presses for "actions on this". Focus goes to the first item; the
    arrow keys, Home and End move it; Enter or Space chooses; Escape or Tab
    closes and puts focus back on the row.

    It is drawn fixed-position beside the row rather than inside it, because
    the tree is a virtualized scroll container and a menu inside a row would
    be clipped by it.

    What a row offers: a class of this document, Add subclass, Rename,
    Delete…; a concept, Add narrower concept instead; any other entity of the
    document, Rename and Delete…; an imported class, Add subclass only, since
    making a subclass of FOAF's Person is this project's own change; anything
    else imported, nothing. Past 300 boxes the canvas draws a chosen set
    (visual-modeling 5.6), and a class or concept row then also offers *Show
    on canvas* or *Hide from canvas*. A row of the project's other kind (a
    concept in an ontology, a class in a taxonomy, D-089) offers nothing of
    its own: it is changed in Turtle, or after changing the kind.

INPUTS / INPUT SOURCES (props)
    - label: the row's name, for the menu's accessible name.
    - items: what it offers; anchor: where to draw it.
    - onChoose(action), onClose: the choice, or none.

EXPECTED OUTPUT
    - rowActions(kind, imported, canvas, otherKind) and the RowMenu component.
================================================================================
*/

import { useEffect, useRef } from "react";

export type RowAction = "addChild" | "rename" | "delete" | "show" | "hide";

export interface MenuItem {
  action: RowAction;
  label: string;
}

/** What a row offers, by its kind and whether it comes from an import. */
export function rowActions(
  kind: string,
  imported: boolean,
  canvas: { limited: boolean; shown: boolean } | null = null,
  otherKind = false,
): MenuItem[] {
  const drawable = kind === "class" || kind === "concept";
  const onCanvas: MenuItem[] =
    canvas?.limited && drawable
      ? [canvas.shown ? { action: "hide", label: "Hide from canvas" } : { action: "show", label: "Show on canvas" }]
      : [];
  return [...(otherKind ? [] : ownActions(kind, imported)), ...onCanvas];
}

function ownActions(kind: string, imported: boolean): MenuItem[] {
  if (imported) return kind === "class" ? [{ action: "addChild", label: "Add subclass" }] : [];
  const rest: MenuItem[] = [
    { action: "rename", label: "Rename" },
    { action: "delete", label: "Delete…" },
  ];
  if (kind === "class") return [{ action: "addChild", label: "Add subclass" }, ...rest];
  if (kind === "concept") return [{ action: "addChild", label: "Add narrower concept" }, ...rest];
  return rest;
}

interface Props {
  label: string;
  items: MenuItem[];
  anchor: { top: number; left: number };
  onChoose: (action: RowAction) => void;
  onClose: () => void;
}

export function RowMenu({ label, items, anchor, onChoose, onClose }: Props) {
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    // A press anywhere else closes it, as a menu does.
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [onClose]);

  const move = (step: number | "first" | "last") => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = all.indexOf(document.activeElement as HTMLElement);
    const next =
      step === "first" ? 0 : step === "last" ? all.length - 1 : (at + step + all.length) % all.length;
    all[next]?.focus();
  };

  return (
    <ul
      ref={ref}
      role="menu"
      aria-label={`More actions for ${label}`}
      className="row-menu"
      style={{ top: anchor.top, left: anchor.left }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") move(1);
        else if (e.key === "ArrowUp") move(-1);
        else if (e.key === "Home") move("first");
        else if (e.key === "End") move("last");
        else if (e.key === "Escape" || e.key === "Tab") onClose();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((item) => (
        <li key={item.action} role="none">
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => onChoose(item.action)}>
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
