/*
================================================================================
FILE: frontend/src/canvas/ClassNode.tsx
================================================================================

SUMMARY
    A class box on the modeling canvas (visual-modeling 5.4): its name in the
    display language, its attributes listed inside as *name : type*, and a
    *+ attribute* control; an imported class dashed, named by its import, and
    read-only. Also NameLine, the name or its rename field, which the concept
    box shares.

BASIC IDEA
    React Flow draws the box and makes it focusable; this draws what is in it.
    Everything a box does is handed in through its data by ModelCanvas, which
    owns the commands, so a box holds nothing but the text being typed.

    Fields inside a box carry React Flow's `nodrag` class and keep their keys
    to themselves: typing a name must not move the box or reach the canvas's
    Enter-to-rename and Delete handling.

    A fallback name keeps its *(en)* marker in the text (5.4), and the
    imported box says *from FOAF* in text as well as being dashed: nothing is
    told by colour or line style alone.

INPUTS / INPUT SOURCES
    - data: see BoxData.

EXPECTED OUTPUT
    - The box; the rename and attribute callbacks.
================================================================================
*/

import { memo, useState } from "react";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { DATATYPES } from "../modeling/values";
import type { CanvasNode } from "../types";

export interface BoxData extends Record<string, unknown> {
  node: CanvasNode;
  // The drop target while a palette item is dragged over it.
  dropTarget: boolean;
  renaming: boolean;
  busy: boolean;
  onRenameDone: (iri: string, value: string | null) => void;
  onAddAttribute: (iri: string, name: string, datatype: string) => Promise<boolean>;
}

export type BoxNode = Node<BoxData, "class" | "concept">;

/** One handle on every side, so a line can leave and arrive by the side
 *  facing the other box: with one handle top and one bottom, a relationship
 *  between two boxes in a row looped round both (measured in the browser
 *  pass). One per side, not a source and a target stacked: the pointer
 *  landed on whichever was on top, and a line started on a target handle
 *  comes back reversed, so "Invoice item to Invoice" read "Invoice to
 *  Invoice item". The canvas connects in loose mode instead, where any
 *  handle starts or ends a line. Hidden until the box is hovered or focused.
 */
export function Sides() {
  return (
    <>
      {([
        ["t", Position.Top],
        ["r", Position.Right],
        ["b", Position.Bottom],
        ["l", Position.Left],
      ] as const).map(([side, position]) => (
        <Handle key={side} id={side} type="source" position={position} />
      ))}
    </>
  );
}

/** Keys typed into a field stay in it. */
export const keep = (e: React.KeyboardEvent) => e.stopPropagation();

export function NameLine({ data }: { data: BoxData }) {
  const { node, renaming, busy, onRenameDone } = data;
  const [value, setValue] = useState(node.label.replace(/ \([^)]*\)$/, ""));
  if (!renaming) {
    return <span className="canvas-box-name">{node.label}</span>;
  }
  return (
    <input
      className="canvas-rename nodrag"
      aria-label={`New name for ${node.label}`}
      autoFocus
      value={value}
      readOnly={busy}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        keep(e);
        if (e.key === "Enter") {
          e.preventDefault();
          if (!busy) onRenameDone(node.iri, value.trim() && value.trim() !== node.label ? value.trim() : null);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onRenameDone(node.iri, null);
        }
      }}
      onBlur={() => !busy && onRenameDone(node.iri, null)}
    />
  );
}

function ClassNode({ data, selected }: NodeProps<BoxNode>) {
  const { node, dropTarget, busy, onAddAttribute } = data;
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [datatype, setDatatype] = useState("xsd:string");
  const imported = Boolean(node.imported);
  const submit = async () => {
    if (busy || !name.trim()) return;
    if (await onAddAttribute(node.iri, name.trim(), datatype)) {
      setAdding(false);
      setName("");
    }
  };
  return (
    <div
      className={
        "canvas-box canvas-class" +
        (imported ? " imported" : "") +
        (selected ? " selected" : "") +
        (dropTarget ? " drop-target" : "")
      }
    >
      <Sides />
      <NameLine data={data} />
      {imported && (
        <span className="canvas-box-from">
          {node.imported === "outside" ? "outside this model" : `from ${node.imported}`}
        </span>
      )}
      {node.attributes.length > 0 && (
        <ul className="canvas-attributes">
          {node.attributes.map((a) => (
            <li key={a.iri}>
              {a.label} : {a.datatype ?? "no type"}
            </li>
          ))}
        </ul>
      )}
      {!imported &&
        (adding ? (
          <div className="canvas-attr-form nodrag" onKeyDown={keep}>
            <input
              aria-label={`Name of the new attribute of ${node.label}`}
              autoFocus
              value={name}
              readOnly={busy}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
                if (e.key === "Escape") setAdding(false);
              }}
            />
            <select
              aria-label="Type of value"
              value={datatype}
              aria-disabled={busy}
              onChange={(e) => !busy && setDatatype(e.target.value)}
            >
              {DATATYPES.map((d) => (
                <option key={d} value={`xsd:${d}`}>
                  xsd:{d}
                </option>
              ))}
            </select>
            <button type="button" className="primary" aria-disabled={busy || !name.trim()} onClick={() => void submit()}>
              Add
            </button>
            <button type="button" className="ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="canvas-add-attr nodrag"
            aria-label={`Add an attribute to ${node.label}`}
            onClick={() => setAdding(true)}
          >
            + attribute
          </button>
        ))}
    </div>
  );
}

export default memo(ClassNode);
