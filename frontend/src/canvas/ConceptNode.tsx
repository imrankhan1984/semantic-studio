/*
================================================================================
FILE: frontend/src/canvas/ConceptNode.tsx
================================================================================

SUMMARY
    A concept box on the modeling canvas (visual-modeling 5.4): a rounded box
    in the concept colour, with the word *concept* written in it, so a concept
    is never told from a class by colour alone.

BASIC IDEA
    The class box without attributes: the same name line and rename field
    (ClassNode's NameLine), the same imported marking, and handles to draw
    *narrower than* from it. In an ontology a concept is dotted and marked
    *read-only in an ontology* (relationships 5.1, D-089).

INPUTS / INPUT SOURCES
    - data: ClassNode's BoxData.

EXPECTED OUTPUT
    - The box.
================================================================================
*/

import { memo } from "react";
import type { NodeProps } from "@xyflow/react";
import { NameLine, Sides, type BoxNode } from "./ClassNode";

function ConceptNode({ data, selected }: NodeProps<BoxNode>) {
  const { node, dropTarget } = data;
  return (
    <div
      className={
        "canvas-box canvas-concept" +
        (node.imported ? " imported" : "") +
        (data.otherKind ? " other-kind" : "") +
        (selected ? " selected" : "") +
        (dropTarget ? " drop-target" : "")
      }
    >
      <Sides />
      <span className="canvas-box-marker">concept</span>
      <NameLine data={data} />
      {data.otherKind && <span className="canvas-box-from">read-only in an ontology</span>}
      {node.imported && (
        <span className="canvas-box-from">
          {node.imported === "outside" ? "outside this model" : `from ${node.imported}`}
        </span>
      )}
    </div>
  );
}

export default memo(ConceptNode);
