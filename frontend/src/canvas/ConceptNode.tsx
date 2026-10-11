/*
================================================================================
FILE: frontend/src/canvas/ConceptNode.tsx
================================================================================

SUMMARY
    A concept box on the modeling canvas (visual-modeling 5.4): a rounded box
    with the concept's band and header tint, and the word *CONCEPT* at the
    header's right (edit-page-rework 5.8), so a concept is never told from a
    class by colour alone.

BASIC IDEA
    The class box without attributes: the same header and rename field
    (ClassNode's BoxHead), the same imported marking, and handles to draw
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
import { BoxHead, Sides, boxClasses, type BoxNode } from "./ClassNode";

function ConceptNode({ data, selected }: NodeProps<BoxNode>) {
  return (
    <div className={boxClasses(data, Boolean(selected))}>
      <Sides />
      <BoxHead data={data} />
      {data.otherKind && (
        <div className="canvas-box-body">
          <span className="canvas-box-from">read-only in an ontology</span>
        </div>
      )}
    </div>
  );
}

export default memo(ConceptNode);
