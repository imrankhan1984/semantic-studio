/*
================================================================================
FILE: frontend/src/canvas/ModelCanvas.tsx
================================================================================

SUMMARY
    The modeling canvas (visual-modeling 5.4 to 5.6, D-086): a project's
    model.ttl drawn as boxes and lines on React Flow, between the tree and the
    form in the Hierarchy view. Drag a Class or a Concept from the palette to
    make one; drop it on a box to make a kind of it; draw a line between two
    boxes to relate them; double-click or press Enter to rename; press Delete
    to delete. Every change is one E-6 command, through the same runner as
    the form. App loads this file with React.lazy, so React Flow is fetched
    from the local server the first time a canvas opens, and never before.

BASIC IDEA
    What is drawn is the server's canvas view (canvas.py), fetched for each
    revision; where it is drawn is the layout file, kept by useCanvasData.
    React Flow holds the boxes while they are dragged and measured, and a
    move is committed -- and saved a second later -- when a drag ends or an
    arrow key has moved a box. A command's refetch rebuilds the boxes and
    keeps every one where it was.

    The canvas is an extra view, never the only way (D-078, D-025): each thing
    it does is also a tree or form action. Its keyboard is the box's: Tab
    reaches the boxes in reading order (they are sorted by row, then column),
    the arrow keys move the focused box, Enter renames, Delete deletes, + and
    - zoom, and Fit frames everything. A box is named as the tree names a row
    (relate.ts's boxName). Focusing a box selects it, so the form follows the
    keyboard as it follows a click; a selection made elsewhere pans the canvas
    to its box.

    Refusals are sentences. A line that cannot mean anything (a class to a
    concept, a line from an imported box) is refused by relate.ts before any
    menu opens; a command the server refuses shows its sentence where the
    action was.

    Moving a box is not an undo step and never makes the model dirty (5.5).

INPUTS / INPUT SOURCES (props)
    - projectId, doc, revision, language, primaryLanguage: the document, and
      the language names are shown and renamed in.
    - selected, onSelect: the shared selection (D-047).
    - onDeleted: an entity deleted from the canvas.
    - onCanvasSet: tells App the shown set past 300 boxes, for the tree's and
      the form's Show on canvas and Hide from canvas (5.6).

EXPECTED OUTPUT
    - The canvas, its palette, toolbar, menus and dialogs; commands through
      the project store; layout writes through useCanvasData.
================================================================================
*/

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyNodeChanges,
  ConnectionMode,
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
// base.css, not style.css: the full theme sets `outline: none` on a focused
// node, which hid the one global focus ring from every box (measured in the
// accessibility pass). The base has what React Flow needs to work and
// nothing that fights the application's own look; index.css styles the rest.
import "@xyflow/react/dist/base.css";
import ConfirmDialog from "../components/ConfirmDialog";
import DeleteDialog from "../components/DeleteDialog";
import { getNodeDetails } from "../api";
import { useRunner } from "../components/EditParts";
import { projectStore } from "../state/projectStore";
import type { CanvasSet, CanvasView, ProjectDocName } from "../types";
import ClassNode, { type BoxData, type BoxNode } from "./ClassNode";
import ConceptNode from "./ConceptNode";
import { BOX_HEIGHT } from "./layered";
import RelateMenu from "./RelateMenu";
import { boxName, relateChoices, type RelateChoice } from "./relate";
import { useCanvasData } from "./useCanvasData";

export interface ModelCanvasProps {
  projectId: string;
  doc: ProjectDocName;
  revision: number;
  language: string | null;
  primaryLanguage: string;
  selected: string | null;
  onSelect: (iri: string) => void;
  onDeleted: (iri: string) => void;
  onCanvasSet?: (set: CanvasSet | null) => void;
}

/** The palette's drag data, one type per kind: dragover cannot read the
 *  data itself, only its types, and the drop target depends on the kind. */
const DRAG_TYPE = { class: "application/x-semantic-studio-class", concept: "application/x-semantic-studio-concept" };

const nodeTypes = { class: ClassNode, concept: ConceptNode };

/** A line: *is a kind of* and *narrower than* show their words on hover and
 *  focus (5.4); a relationship always shows its name. */
function LabelledEdge(props: EdgeProps<Edge<{ text: string; always: boolean; hover: boolean }>>) {
  const [path, x, y] = getBezierPath(props);
  const show = props.data && (props.data.always || props.data.hover || props.selected);
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} className={`canvas-edge ${props.data?.always ? "relationship" : ""}`} />
      {show && (
        <EdgeLabelRenderer>
          <span className="canvas-edge-label" style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>
            {props.data!.text}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { labelled: LabelledEdge };

interface Draft {
  kind: "class" | "concept";
  at: [number, number];
  parent?: string;
}

function Canvas(props: ModelCanvasProps) {
  const { projectId, doc, revision, language, primaryLanguage, selected, onSelect, onDeleted, onCanvasSet } = props;
  const data = useCanvasData(projectId, doc, revision, language);
  const { view, positions } = data;
  const flow = useReactFlow();
  const runner = useRunner();
  const { busy, errors, run, clear, alive } = runner;
  const wrapper = useRef<HTMLDivElement>(null);
  // matchMedia once per mount, as GraphView reads it (CLAUDE.md).
  const reduced = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  const [nodes, setNodes] = useState<BoxNode[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftName, setDraftName] = useState("");
  const [hint, setHint] = useState("");
  const [relate, setRelate] = useState<{ from: string; to: string; choices: RelateChoice[]; notes: string[] } | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const [deleting, setDeleting] = useState<{ iri: string; label: string } | null>(null);
  const [tidying, setTidying] = useState(false);
  const [undrawnOpen, setUndrawnOpen] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  // The last selection the canvas made itself, so it does not pan to it.
  const madeHere = useRef<string | null>(null);
  // A box just deleted is still drawn until the refetch, and the dialog gives
  // focus back to it as it closes; focusing a box selects it, which
  // re-selected the entity the delete had cleared (measured in the browser
  // pass). Its focus is ignored, and focus goes to the canvas instead.
  const justDeleted = useRef<string | null>(null);
  const section = useRef<HTMLElement>(null);

  const selectHere = useCallback(
    (iri: string) => {
      madeHere.current = iri;
      onSelect(iri);
    },
    [onSelect],
  );
  const selectedNow = useRef(selected);
  selectedNow.current = selected;

  const focusBox = useCallback((iri: string) => {
    window.setTimeout(() => {
      wrapper.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(iri)}"]`)?.focus();
    }, 0);
  }, []);

  // --- commands ----------------------------------------------------------------

  const onRenameDone = useCallback(
    async (iri: string, value: string | null) => {
      if (value === null) {
        setRenaming(null);
        focusBox(iri);
        return;
      }
      // A refusal is the runner's errors.rename, which the status line shows;
      // an older hint would stand in front of it (found in review).
      setHint("");
      if (await run("rename", "SetLabel", { iri, value, lang: language ?? primaryLanguage })) {
        setRenaming(null);
        focusBox(iri);
      }
    },
    [run, language, primaryLanguage, focusBox],
  );

  const onAddAttribute = useCallback(
    async (iri: string, name: string, datatype: string) =>
      (await run("attribute", "CreateDatatypeProperty", { label: name, domain: iri, datatype })) !== null,
    [run],
  );

  const createDraft = async () => {
    if (!draft || busy) return;
    const name = draftName.trim();
    if (!name) {
      setDraft(null);
      return;
    }
    const before = selectedNow.current;
    const args =
      draft.kind === "class"
        ? { label: name, ...(draft.parent ? { parent: draft.parent } : {}) }
        : { prefLabel: name, ...(draft.parent ? { broader: draft.parent } : {}) };
    const result = await run("draft", draft.kind === "class" ? "CreateClass" : "CreateConcept", args);
    if (!result) return;
    if (result.created) {
      data.place(result.created, draft.at);
      // Only if nothing else was selected while it ran (5.8 item 4).
      if (alive() && selectedNow.current === before) {
        selectHere(result.created);
        focusBox(result.created);
      }
    }
    setDraft(null);
    setDraftName("");
  };

  const choose = async (choice: RelateChoice, name?: string) => {
    if (!relate) return;
    const { from, to } = relate;
    let ok = true;
    if (choice.kind === "subClassOf") ok = !!(await run("relate", "AddSubClassOf", { child: from, parent: to }));
    else if (choice.kind === "broader") ok = !!(await run("relate", "AddBroader", { concept: from, broader: to }));
    else if (choice.kind === "newRelationship")
      ok = !!(await run("relate", "CreateObjectProperty", { label: name, domain: from, range: to }));
    else {
      if (choice.setDomain) ok = !!(await run("relate", "SetDomain", { property: choice.property, target: from }));
      if (ok && choice.setRange) ok = !!(await run("relate", "SetRange", { property: choice.property, target: to }));
    }
    if (ok) {
      setRelate(null);
      focusBox(from);
    }
  };

  const removeEdge = async (id: string) => {
    const edge = view?.edges.find((e) => edgeId(e) === id);
    if (!edge) return;
    if (edge.kind === "subClassOf") await run("edge", "RemoveSubClassOf", { child: edge.source, parent: edge.target });
    else if (edge.kind === "broader") await run("edge", "RemoveBroader", { concept: edge.source, broader: edge.target });
    else if (edge.property) setDeleting({ iri: edge.property, label: edge.label ?? edge.property });
    setSelectedEdge(null);
  };

  // --- what React Flow draws ------------------------------------------------------

  useEffect(() => {
    if (!view) return;
    setNodes((previous) => {
      const measured = new Map(previous.map((n) => [n.id, n.measured]));
      const boxes = view.nodes
        .filter((n) => positions[n.iri])
        .map<BoxNode>((n) => {
          const data: BoxData = {
            node: n,
            dropTarget: dropTarget === n.iri,
            renaming: renaming === n.iri,
            busy,
            onRenameDone: (iri, value) => void onRenameDone(iri, value),
            onAddAttribute,
          };
          return {
            id: n.iri,
            type: n.kind,
            position: { x: positions[n.iri][0], y: positions[n.iri][1] },
            data,
            selected: n.iri === selected,
            ariaLabel: boxName(view, n.iri),
            // An imported box is linked to, never changed or moved about.
            draggable: !n.imported,
            connectable: true,
            measured: measured.get(n.iri),
          };
        });
      // Reading order: Tab walks the boxes row by row, left to right.
      boxes.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
      return boxes;
    });
  }, [view, positions, selected, renaming, dropTarget, busy, onRenameDone, onAddAttribute]);

  const edges = useMemo<Edge[]>(() => {
    if (!view) return [];
    return view.edges.map((e) => {
      const id = edgeId(e);
      const relationship = e.kind === "relationship";
      const [out, into] = sides(positions[e.source], positions[e.target]);
      return {
        id,
        source: e.source,
        target: e.target,
        sourceHandle: out,
        targetHandle: into,
        type: "labelled",
        selected: id === selectedEdge,
        ariaLabel:
          e.kind === "subClassOf"
            ? `${label(view, e.source)} is a kind of ${label(view, e.target)}`
            : e.kind === "broader"
              ? `${label(view, e.source)} is narrower than ${label(view, e.target)}`
              : `${label(view, e.source)} ${e.label} ${label(view, e.target)}`,
        // A hollow triangle at the parent for a subclass (5.4); an arrow for
        // the others. The hollow one is ours: React Flow draws only filled
        // and open arrows.
        markerEnd: e.kind === "subClassOf" ? "canvas-hollow" : { type: relationship ? MarkerType.ArrowClosed : MarkerType.Arrow },
        data: {
          text: relationship ? (e.label ?? "") : e.kind === "subClassOf" ? "is a kind of" : "narrower than",
          always: relationship,
          hover: hover === id,
        },
      };
    });
  }, [view, hover, selectedEdge, positions]);

  // --- selection made elsewhere pans here (D-047) ------------------------------------

  // Once per selection: positions change on every refetch, and the canvas
  // re-centred on the selected box after each form edit (PR #47 review). It
  // still pans when a newly selected box only gets its place a moment later.
  const panned = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) {
      panned.current = null;
      return;
    }
    if (panned.current === selected) return;
    if (madeHere.current === selected) {
      panned.current = selected;
      return;
    }
    const at = positions[selected];
    if (!at) return;
    panned.current = selected;
    void flow.setCenter(at[0] + 95, at[1] + BOX_HEIGHT / 2, { zoom: flow.getZoom(), duration: reduced ? 0 : 300 });
  }, [selected, positions, flow, reduced]);

  // A move made just before Close must not be lost: the project store waits
  // for this before it closes the project (PR #47 review).
  useEffect(() => projectStore.registerFlush(data.flush), [data.flush]);

  // --- 5.6: lend the shown set to the tree and the form ------------------------------

  useEffect(() => {
    if (!view) return;
    onCanvasSet?.({ limited: view.limited, shown: data.shown ?? [], show: data.show, hide: data.hide });
  }, [view, data.shown, data.show, data.hide, onCanvasSet]);
  useEffect(() => () => onCanvasSet?.(null), [onCanvasSet]);
  // Past 300 with nothing ever chosen: start on the selected entity (5.6).
  // Only while `shown` is null, never after the user emptied the set: hiding
  // the last box re-added it at once (found in review). And only a class or
  // concept: a property or an individual is not a box, and past 300 the
  // selection is usually not drawn, so its kind is asked for (PR #47
  // review; before, anything selected was added).
  const selectedKind = useRef<string | null>(null);
  useEffect(() => {
    if (!view?.limited || data.shown !== null || !selected) return;
    if (selectedKind.current === selected) return;
    selectedKind.current = selected;
    let cancelled = false;
    getNodeDetails(`${projectId}-${doc}`, selected)
      .then((details) => {
        if (!cancelled && (details.kind === "class" || details.kind === "concept")) void data.show(selected);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [view, data.shown, selected, data.show, projectId, doc]);
  // The deleted box is gone from the view: its focus counts again, so an
  // undo that restores it can select it (found in review).
  useEffect(() => {
    if (justDeleted.current && view && !view.nodes.some((n) => n.iri === justDeleted.current)) {
      justDeleted.current = null;
    }
  }, [view]);

  // --- handlers ----------------------------------------------------------------

  const onNodesChange = useCallback(
    (changes: NodeChange<BoxNode>[]) => {
      setNodes((current) => applyNodeChanges(changes, current));
      for (const change of changes) {
        // A drag's last change, or an arrow key's move, commits the place.
        if (change.type === "position" && change.position && !change.dragging) {
          data.move(change.id, [change.position.x, change.position.y]);
        }
      }
    },
    [data.move],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!view) return;
      clear("relate");
      const result = relateChoices(view, connection.source, connection.target);
      if ("refusal" in result) {
        setHint(result.refusal);
        setRelate(null);
      } else {
        setHint("");
        setRelate({ from: connection.source, to: connection.target, ...result });
      }
    },
    [view, clear],
  );

  const kindDragged = (e: React.DragEvent): "class" | "concept" | null =>
    e.dataTransfer.types.includes(DRAG_TYPE.class) ? "class" : e.dataTransfer.types.includes(DRAG_TYPE.concept) ? "concept" : null;

  const targetUnder = (e: React.DragEvent, kind: "class" | "concept") => {
    const el = document.elementFromPoint?.(e.clientX, e.clientY)?.closest<HTMLElement>(".react-flow__node");
    const id = el?.dataset.id;
    const node = id ? view?.nodes.find((n) => n.iri === id) : undefined;
    return node && node.kind === kind ? node : null;
  };

  const onDragOver = (e: React.DragEvent) => {
    const kind = kindDragged(e);
    if (!kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const target = targetUnder(e, kind);
    setDropTarget(target?.iri ?? null);
    setHint(
      target
        ? kind === "class"
          ? `Drop to make a kind of ${target.label}`
          : `Drop to make a narrower concept of ${target.label}`
        : "",
    );
  };

  const onDrop = (e: React.DragEvent) => {
    const kind = kindDragged(e);
    if (!kind) return;
    e.preventDefault();
    const target = targetUnder(e, kind);
    setDropTarget(null);
    setHint("");
    const at = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const place: [number, number] = target && positions[target.iri]
      ? [positions[target.iri][0], positions[target.iri][1] + 170]
      : [at.x, at.y];
    setDraft({ kind, at: place, parent: target?.iri });
    setDraftName("");
  };

  /** The palette by keyboard or click: a new box in the middle of the view. */
  const startDraft = (kind: "class" | "concept") => {
    const box = wrapper.current?.getBoundingClientRect();
    const at = flow.screenToFlowPosition({ x: (box?.left ?? 0) + (box?.width ?? 0) / 2, y: (box?.top ?? 0) + (box?.height ?? 0) / 2 });
    setDraft({ kind, at: [at.x, at.y] });
    setDraftName("");
  };

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    // A control inside a box keeps its own keys: Enter on "+ attribute" is
    // a press, not a rename, and Backspace there deletes nothing (found in
    // review).
    if (target.closest("input, textarea, select, button")) return;
    const box = target.closest<HTMLElement>(".react-flow__node");
    const id = box?.dataset.id;
    const node = id ? view?.nodes.find((n) => n.iri === id) : undefined;
    if (node && e.key === "Enter" && !node.imported) {
      // Enter renames (5.4); React Flow's own Enter would only select.
      e.preventDefault();
      e.stopPropagation();
      setRenaming(node.iri);
    } else if (node && (e.key === "Delete" || e.key === "Backspace") && !node.imported) {
      e.preventDefault();
      e.stopPropagation();
      setDeleting({ iri: node.iri, label: node.label });
    } else if (!node && selectedEdge && (e.key === "Delete" || e.key === "Backspace")) {
      e.preventDefault();
      setHint("");
      void removeEdge(selectedEdge);
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      void flow.zoomIn({ duration: reduced ? 0 : 150 });
    } else if (e.key === "-") {
      e.preventDefault();
      void flow.zoomOut({ duration: reduced ? 0 : 150 });
    }
  };

  // --- states ------------------------------------------------------------------

  if (data.error) {
    return (
      <section className="model-canvas canvas-message" aria-label="Modeling canvas">
        <p>The canvas could not load. The tree and the form still work.</p>
        <p className="detail-note">{data.error}</p>
        <button type="button" className="ghost" onClick={data.retry}>
          Retry
        </button>
      </section>
    );
  }
  if (!view) {
    return (
      <section className="model-canvas canvas-message" aria-label="Modeling canvas" aria-busy="true">
        <p role="status">Loading the canvas…</p>
      </section>
    );
  }

  const undrawn = view.undrawn.filter((u) => u.kind === "objectProperty");
  const empty = view.total === 0;
  const draftNode = draft ? flow.flowToScreenPosition({ x: draft.at[0], y: draft.at[1] }) : null;
  const origin = wrapper.current?.getBoundingClientRect();
  const refused = errors.draft || errors.rename || errors.attribute || errors.edge || data.saveError || "";

  return (
    <section className="model-canvas" aria-label="Modeling canvas" aria-busy={busy} ref={section} tabIndex={-1}>
      <svg className="canvas-defs" aria-hidden="true" width="0" height="0">
        <defs>
          <marker id="canvas-hollow" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="14" markerHeight="14" orient="auto-start-reverse">
            <path d="M1,1 L11,6 L1,11 z" className="canvas-hollow" />
          </marker>
        </defs>
      </svg>
      <div className="canvas-toolbar" role="toolbar" aria-label="Canvas">
        <span className="canvas-palette-label">Drag onto the canvas:</span>
        {(["class", "concept"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className="canvas-palette-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE[kind], kind);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => startDraft(kind)}
            title={`Drag onto the canvas, or press to add a ${kind} in the middle`}
          >
            {kind === "class" ? "Class" : "Concept"}
          </button>
        ))}
        <span className="canvas-toolbar-gap" />
        <button type="button" className="ghost" onClick={() => void flow.zoomIn({ duration: reduced ? 0 : 150 })} aria-label="Zoom in">
          +
        </button>
        <button type="button" className="ghost" onClick={() => void flow.zoomOut({ duration: reduced ? 0 : 150 })} aria-label="Zoom out">
          −
        </button>
        <button type="button" className="ghost" onClick={() => void flow.fitView({ duration: reduced ? 0 : 200, maxZoom: 1 })}>
          Fit
        </button>
        <button
          type="button"
          className="ghost"
          // aria-disabled, not disabled: disabling the focused control drops
          // its focus (CLAUDE.md, authoring foundations).
          aria-disabled={nodes.length === 0}
          onClick={() => nodes.length > 0 && setTidying(true)}
        >
          Tidy up
        </button>
        {undrawn.length > 0 && (
          <button type="button" className="ghost" aria-expanded={undrawnOpen} onClick={() => setUndrawnOpen((o) => !o)}>
            {undrawn.length} {undrawn.length === 1 ? "relationship" : "relationships"} not drawn
          </button>
        )}
      </div>
      {undrawnOpen && (
        <ul className="canvas-undrawn" aria-label="Relationships not drawn">
          {undrawn.map((u) => (
            <li key={u.iri}>
              <button type="button" className="term-link" onClick={() => onSelect(u.iri)}>
                {u.label}
              </button>{" "}
              <span className="detail-note">{UNDRAWN_WHY[u.missing]}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="canvas-hint" role="status">
        {busy ? "Saving change…" : hint || refused}
      </p>
      {view.limited && (
        <p className="detail-note canvas-limited">
          This model has {view.total.toLocaleString()} classes and concepts; the canvas shows the ones you choose.
        </p>
      )}
      <div
        className="canvas-surface"
        ref={wrapper}
        // Script-focusable only, for a selected line's Delete key.
        tabIndex={-1}
        onDragOver={onDragOver}
        onDragLeave={() => setDropTarget(null)}
        onDrop={onDrop}
        onKeyDownCapture={onKeyDownCapture}
        onFocusCapture={(e) => {
          const id = (e.target as HTMLElement).classList.contains("react-flow__node")
            ? (e.target as HTMLElement).dataset.id
            : undefined;
          if (id && id !== selectedNow.current && id !== justDeleted.current) selectHere(id);
        }}
        onDoubleClick={(e) => {
          const id = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node")?.dataset.id;
          const node = id ? view.nodes.find((n) => n.iri === id) : undefined;
          if (node && !node.imported && (e.target as HTMLElement).closest(".canvas-box-name")) setRenaming(node.iri);
        }}
      >
        <ReactFlow<BoxNode, Edge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          // Any handle starts or ends a line, and the line runs from where it
          // started (see ClassNode's Sides).
          connectionMode={ConnectionMode.Loose}
          onConnectEnd={(event) => {
            const point = "clientX" in event ? event : event.changedTouches[0];
            const box = wrapper.current?.getBoundingClientRect();
            setAnchor({ x: point.clientX - (box?.left ?? 0), y: point.clientY - (box?.top ?? 0) });
          }}
          onNodeClick={(_, node) => selectHere(node.id)}
          onEdgeClick={(_, edge) => {
            // A click on a line focuses nothing, so the Delete key went to the
            // page and never reached this canvas (PR #47 review): focus the
            // surface, where the key handler is, and say what Delete will do.
            setSelectedEdge(edge.id);
            setHint(`${edge.ariaLabel ?? "Line"} selected. Delete removes it.`);
            wrapper.current?.focus();
          }}
          onEdgeMouseEnter={(_, edge) => setHover(edge.id)}
          onEdgeMouseLeave={() => setHover(null)}
          onPaneClick={() => {
            setSelectedEdge(null);
            setRelate(null);
          }}
          onMoveEnd={(_, viewport: Viewport) => data.setViewport(viewport)}
          defaultViewport={data.savedViewport ?? undefined}
          fitView={!data.savedViewport}
          // Never larger than life: two boxes filled the canvas at 2x.
          fitViewOptions={{ maxZoom: 1 }}
          // Delete is ours: it opens the impact dialog, never removes silently.
          deleteKeyCode={null}
          nodesFocusable
          // Lines are not Tab stops: Tab walks the boxes in reading order
          // (5.4), each box's name already says what its lines say, and the
          // form removes a link by keyboard. A line is selected by pointer.
          edgesFocusable={false}
          minZoom={0.2}
          maxZoom={2}
        />
        {empty && !draft && <p className="canvas-empty">Drag a Class here to start</p>}
        {draft && draftNode && origin && (
          <div
            className={`canvas-box canvas-draft canvas-${draft.kind}`}
            style={{ left: draftNode.x - origin.left, top: draftNode.y - origin.top }}
          >
            <input
              className="nodrag"
              autoFocus
              aria-label={
                draft.parent
                  ? `Name of the new ${draft.kind === "class" ? "subclass" : "narrower concept"} of ${label(view, draft.parent)}`
                  : `Name of the new ${draft.kind}`
              }
              value={draftName}
              readOnly={busy}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createDraft();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setDraft(null);
                }
              }}
              onBlur={() => !busy && !draftName.trim() && setDraft(null)}
            />
            {errors.draft && <p className="edit-error">{errors.draft}</p>}
          </div>
        )}
        {relate && anchor && (
          <RelateMenu
            title={`${label(view, relate.from)} to ${label(view, relate.to)}`}
            choices={relate.choices}
            notes={relate.notes}
            anchor={anchor}
            busy={busy}
            error={errors.relate || null}
            onChoose={(choice, name) => void choose(choice, name)}
            onClose={() => {
              setRelate(null);
              focusBox(relate.from);
            }}
          />
        )}
      </div>
      {deleting && (
        <DeleteDialog
          iri={deleting.iri}
          label={deleting.label}
          runner={runner}
          onDone={(deleted) => {
            const gone = deleting.iri;
            setDeleting(null);
            if (deleted) {
              justDeleted.current = gone;
              onDeleted(gone);
              // After the dialog has given focus back, which it does as it goes.
              window.setTimeout(() => section.current?.focus(), 0);
            } else {
              focusBox(gone);
            }
          }}
        />
      )}
      {tidying && (
        <ConfirmDialog
          title="Tidy up the canvas?"
          escape="cancel"
          actions={[
            { id: "tidy", label: "Tidy up", primary: true },
            { id: "cancel", label: "Cancel" },
          ]}
          onAnswer={(id) => {
            setTidying(false);
            if (id === "tidy") data.tidy();
          }}
        >
          <p>This moves every box. Positions you set are replaced.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}

/** The sides a line leaves and enters by: whichever face each other. */
function sides(from?: [number, number], to?: [number, number]): ["t" | "r" | "b" | "l", "t" | "r" | "b" | "l"] {
  if (!from || !to) return ["b", "t"];
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? ["r", "l"] : ["l", "r"];
  return dy > 0 ? ["b", "t"] : ["t", "b"];
}

const UNDRAWN_WHY: Record<CanvasView["undrawn"][number]["missing"], string> = {
  domain: "no domain",
  range: "no range",
  both: "no domain or range",
  expression: "an end written as an expression; edit it in Turtle",
  outside: "of a class outside this model",
};

function edgeId(e: CanvasView["edges"][number]): string {
  return `${e.kind}|${e.source}|${e.target}|${e.property ?? ""}`;
}

function label(view: CanvasView, iri: string): string {
  return view.nodes.find((n) => n.iri === iri)?.label ?? iri;
}

/** The lazily loaded module's one export. */
export default function ModelCanvas(props: ModelCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
