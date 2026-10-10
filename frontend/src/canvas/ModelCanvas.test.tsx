// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/canvas/ModelCanvas.test.tsx
================================================================================

SUMMARY
    The modeling canvas (visual-modeling Stage 2, AC-10 to AC-14): what it
    draws and how it names it, the empty, too-big and error states, the
    palette, a drop onto a class, the relate menu and its refusals, rename,
    delete, moving a box, the shared selection, and that React Flow is only
    ever loaded lazily.

BASIC IDEA
    React Flow is stubbed, as GraphView's tests stub Sigma: the stub renders
    each node through the canvas's own node components and keeps the props
    the canvas handed it, so a test can call onConnect or onNodesChange
    exactly as React Flow would. What React Flow does with a pointer is its
    own business, and the browser pass (run-semantic-viewer) drives the real
    thing. api.ts is mocked, and the project store opened on a mocked project
    so commands have somewhere to go.

INPUTS / INPUT SOURCES
    - A mocked api.ts; a stubbed @xyflow/react.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { projectStore } from "../state/projectStore";
import type { CanvasLayout, CanvasView } from "../types";

const { openProject, closeProject, runCommand, getCanvas, putLayout, previewDelete, getNodeDetails } = vi.hoisted(() => ({
  openProject: vi.fn(),
  closeProject: vi.fn(),
  runCommand: vi.fn(),
  getCanvas: vi.fn(),
  putLayout: vi.fn(),
  previewDelete: vi.fn(),
  getNodeDetails: vi.fn(),
}));
vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, openProject, closeProject, runCommand, getCanvas, putLayout, previewDelete, getNodeDetails };
});

// The stub: nodes through the canvas's own node types, and every prop kept.
const flow = vi.hoisted(() => ({
  props: {} as Record<string, any>,
  api: {
    setCenter: vi.fn(),
    getZoom: () => 1,
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    fitView: vi.fn(),
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    flowToScreenPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
  },
}));
vi.mock("@xyflow/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xyflow/react")>();
  function ReactFlow(props: Record<string, any>) {
    flow.props = props;
    const types = props.nodeTypes as Record<string, ComponentType<any>>;
    return (
      <div className="react-flow">
        {(props.nodes as any[]).map((n) => {
          const Box = types[n.type];
          return (
            <div
              key={n.id}
              className="react-flow__node"
              data-id={n.id}
              tabIndex={0}
              aria-label={n.ariaLabel}
              onClick={(e) => props.onNodeClick?.(e, n)}
            >
              <Box id={n.id} data={n.data} selected={n.selected} />
            </div>
          );
        })}
        {(props.edges as any[]).map((e) => (
          <div key={e.id} className="react-flow__edge" aria-label={e.ariaLabel} data-marker={JSON.stringify(e.markerEnd)} />
        ))}
      </div>
    );
  }
  return {
    ...actual,
    ReactFlow,
    ReactFlowProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useReactFlow: () => flow.api,
    Handle: () => null,
  };
});

import ModelCanvas from "./ModelCanvas";

const EX = "http://example.org/shop#";
const PID = "prj-0123456789ab";
const STATE = {
  doc: "model" as const,
  ontologyId: `${PID}-model`,
  revision: 2,
  dirty: true,
  canUndo: true,
  undoLabel: "x",
  canRedo: false,
  redoLabel: null,
  triples: 10,
};

function viewOf(changes: Partial<CanvasView> = {}): CanvasView {
  return {
    revision: 2,
    // A project not opened since kinds: both palette items, every box editable.
    kind: null,
    total: 4,
    limited: false,
    layout: { version: 1, generation: 0, positions: { [EX + "Document"]: [0, 0] }, shown: null, viewport: null },
    nodes: [
      { iri: EX + "Document", kind: "class", label: "Document", fallback: false, attributes: [] },
      {
        iri: EX + "Invoice",
        kind: "class",
        label: "Invoice (en)",
        fallback: true,
        attributes: [{ iri: EX + "total", label: "total", datatype: "xsd:decimal" }],
      },
      { iri: EX + "Paid", kind: "concept", label: "Paid", fallback: false, attributes: [] },
      { iri: EX + "Status", kind: "concept", label: "Status", fallback: false, attributes: [] },
      { iri: "http://xmlns.com/foaf/0.1/Agent", kind: "class", label: "Agent", fallback: false, imported: "FOAF", attributes: [] },
    ],
    edges: [
      { kind: "subClassOf", source: EX + "Invoice", target: EX + "Document", pair: 0, pairs: 1 },
      { kind: "broader", source: EX + "Paid", target: EX + "Status", pair: 0, pairs: 1 },
      {
        kind: "relationship",
        source: EX + "Invoice",
        target: "http://xmlns.com/foaf/0.1/Agent",
        property: EX + "billedTo",
        label: "billed to",
        pair: 0,
        pairs: 1,
      },
    ],
    undrawn: [
      { iri: EX + "mentions", label: "mentions", kind: "objectProperty", missing: "range", domain: EX + "Invoice", range: null },
    ],
    ...changes,
  };
}

const onSelect = vi.fn();
const onSelectLink = vi.fn();
const onDeleted = vi.fn();
const onCanvasSet = vi.fn();

async function renderCanvas(view: CanvasView = viewOf(), selected: string | null = null) {
  getCanvas.mockResolvedValue(view);
  const result = render(
    <ModelCanvas
      projectId={PID}
      doc="model"
      revision={2}
      language="en"
      primaryLanguage="en"
      selected={selected}
      onSelect={onSelect}
      onSelectLink={onSelectLink}
      onDeleted={onDeleted}
      onCanvasSet={onCanvasSet}
    />,
  );
  // Every box drawn, not only the canvas: the boxes come one render after the
  // view, and a test that looked for one then failed about 1 run in 6 on CI
  // (PR #47 review).
  await waitFor(() => {
    expect(document.querySelector(".react-flow")).toBeTruthy();
    expect(document.querySelectorAll(".react-flow__node")).toHaveLength(view.nodes.length);
  });
  return result;
}

const box = (label: string) =>
  [...document.querySelectorAll<HTMLElement>(".react-flow__node")].find(
    (n) => n.querySelector(".canvas-box-name")?.textContent === label,
  )!;
const lastCommand = () => runCommand.mock.calls[runCommand.mock.calls.length - 1].slice(2);

beforeEach(async () => {
  projectStore._reset();
  for (const mock of [openProject, closeProject, runCommand, getCanvas, putLayout, previewDelete, getNodeDetails, onSelect, onSelectLink, onDeleted, onCanvasSet]) {
    mock.mockReset();
  }
  flow.api.setCenter.mockReset();
  openProject.mockResolvedValue({
    project: {
      id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: EX, prefix: "shop",
      primaryLanguage: "en", languages: ["fr"], documents: [{ file: "model.ttl", role: "model" }], counts: {},
    },
    documents: [STATE],
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
  // As the server does: every write one generation on.
  let generation = 0;
  putLayout.mockImplementation(async (_p, _d, layout) => ({ ...layout, generation: ++generation }));
  closeProject.mockResolvedValue({ closed: PID });
  getNodeDetails.mockResolvedValue({ iri: EX + "Invoice", kind: "class" });
  runCommand.mockImplementation(async (_p, _d, command: string) => ({ revision: 3, label: command, state: STATE }));
});

afterEach(() => {
  cleanup();
  projectStore._reset();
  vi.useRealTimers();
});

describe("what the canvas draws (AC-11)", () => {
  it("draws each box named as the tree names a row, attributes inside", async () => {
    await renderCanvas();
    expect(box("Document").getAttribute("aria-label")).toBe("Document, class, 1 subclass");
    expect(box("Invoice (en)").getAttribute("aria-label")).toBe("Invoice (en), class, kind of Document");
    expect(within(box("Invoice (en)")).getByText("total : xsd:decimal")).toBeTruthy();
    // A concept says so in text, not colour alone.
    expect(within(box("Paid")).getByText("concept")).toBeTruthy();
    // An imported box is dashed and says where it is from.
    expect(box("Agent").querySelector(".canvas-box")!.classList.contains("imported")).toBe(true);
    expect(within(box("Agent")).getByText("from FOAF")).toBeTruthy();
    expect(within(box("Agent")).queryByRole("button", { name: /Add an attribute/ })).toBeNull();
  });

  it("names each line, with a hollow triangle for a subclass", async () => {
    await renderCanvas();
    const lines = [...document.querySelectorAll(".react-flow__edge")];
    expect(lines.map((l) => l.getAttribute("aria-label"))).toEqual([
      "Invoice (en) is a kind of Document",
      "Paid is narrower than Status",
      "Invoice (en) billed to Agent",
    ]);
    expect(lines[0].getAttribute("data-marker")).toBe('"canvas-hollow"');
  });

  it("places every box: saved positions kept, the rest laid out and saved", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderCanvas();
    const nodes = flow.props.nodes as { id: string; position: { x: number; y: number } }[];
    expect(nodes.find((n) => n.id === EX + "Document")!.position).toEqual({ x: 0, y: 0 });
    expect(nodes).toHaveLength(5);
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    const saved = putLayout.mock.calls[0][2];
    expect(Object.keys(saved.positions)).toHaveLength(5);
    expect(saved.positions[EX + "Document"]).toEqual([0, 0]);
  });

  it("counts the relationships not drawn, and lists them", async () => {
    await renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: "1 relationship not drawn" }));
    fireEvent.click(within(screen.getByRole("list", { name: "Relationships not drawn" })).getByRole("button", { name: "mentions" }));
    expect(onSelect).toHaveBeenCalledWith(EX + "mentions");
  });
});

describe("the canvas's states", () => {
  it("teaches when empty", async () => {
    await renderCanvas(viewOf({ nodes: [], edges: [], undrawn: [], total: 0 }));
    expect(screen.getByText("Drag a Class here to start")).toBeTruthy();
  });

  it("says when it shows a chosen set, and lends the set to the tree and the form (AC-15)", async () => {
    await renderCanvas(viewOf({ limited: true, total: 2480, nodes: [], edges: [] }), EX + "Invoice");
    expect(screen.getByText("This model has 2,480 classes and concepts; the canvas shows the ones you choose.")).toBeTruthy();
    await waitFor(() => expect(onCanvasSet).toHaveBeenCalledWith(expect.objectContaining({ limited: true })));
    // Nothing chosen yet: it starts on the selected entity.
    await waitFor(() => expect(putLayout).toHaveBeenCalled());
    expect(putLayout.mock.calls[0][2].shown).toEqual([EX + "Invoice"]);
  });

  it("says it could not load, and Retry asks again", async () => {
    getCanvas.mockRejectedValueOnce(new Error("boom"));
    render(
      <ModelCanvas projectId={PID} doc="model" revision={2} language="en" primaryLanguage="en" selected={null} onSelect={onSelect} onDeleted={onDeleted} />,
    );
    expect(await screen.findByText("The canvas could not load. The tree and the form still work.")).toBeTruthy();
    getCanvas.mockResolvedValue(viewOf());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    await waitFor(() => expect(box("Document")).toBeTruthy());
  });
});

describe("creating (AC-12)", () => {
  it("the palette by keyboard: a name, Enter, one CreateClass, placed and selected", async () => {
    runCommand.mockResolvedValueOnce({ revision: 3, label: "Created class Receipt", state: STATE, created: EX + "Receipt" });
    await renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: "Class" }));
    const field = screen.getByRole("textbox", { name: "Name of the new class" });
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "Receipt" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(lastCommand()).toEqual(["CreateClass", { label: "Receipt" }]);
    expect(onSelect).toHaveBeenCalledWith(EX + "Receipt");
    const saved = putLayout.mock.calls[putLayout.mock.calls.length - 1][2];
    expect(saved.positions[EX + "Receipt"]).toBeDefined();
  });

  it("Escape or an empty name sends nothing", async () => {
    await renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: "Concept" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Name of the new concept" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Name of the new concept" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Concept" }));
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Name of the new concept" }), { key: "Enter" });
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("dropped onto a class: highlighted with a hint first, then a subclass of it", async () => {
    await renderCanvas();
    const target = box("Document");
    document.elementFromPoint = vi.fn(() => target.querySelector(".canvas-box"));
    const surface = document.querySelector(".canvas-surface")!;
    const dataTransfer = { types: ["application/x-semantic-studio-class"], dropEffect: "" };
    fireEvent.dragOver(surface, { dataTransfer, clientX: 10, clientY: 10 });
    expect(screen.getByText("Drop to make a kind of Document")).toBeTruthy();
    expect(box("Document").querySelector(".canvas-box")!.classList.contains("drop-target")).toBe(true);
    fireEvent.drop(surface, { dataTransfer, clientX: 10, clientY: 10 });
    const field = screen.getByRole("textbox", { name: "Name of the new subclass of Document" });
    fireEvent.change(field, { target: { value: "Letter" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(lastCommand()).toEqual(["CreateClass", { label: "Letter", parent: EX + "Document" }]);
  });

  it("a concept dropped onto a concept is a narrower concept", async () => {
    await renderCanvas();
    document.elementFromPoint = vi.fn(() => box("Status").querySelector(".canvas-box"));
    const surface = document.querySelector(".canvas-surface")!;
    const dataTransfer = { types: ["application/x-semantic-studio-concept"], dropEffect: "" };
    fireEvent.drop(surface, { dataTransfer, clientX: 10, clientY: 10 });
    const field = screen.getByRole("textbox", { name: "Name of the new narrower concept of Status" });
    fireEvent.change(field, { target: { value: "Late" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(lastCommand()).toEqual(["CreateConcept", { prefLabel: "Late", broader: EX + "Status" }]);
  });

  it("+ attribute sends CreateDatatypeProperty with the chosen type", async () => {
    await renderCanvas();
    fireEvent.click(within(box("Document")).getByRole("button", { name: "Add an attribute to Document" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name of the new attribute of Document" }), { target: { value: "issued" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Type of value" }), { target: { value: "xsd:date" } });
    await act(async () => {
      fireEvent.click(within(box("Document")).getByRole("button", { name: "Add" }));
    });
    expect(lastCommand()).toEqual(["CreateDatatypeProperty", { label: "issued", domain: EX + "Document", datatype: "xsd:date" }]);
  });
});

describe("relating (AC-12)", () => {
  async function draw(from: string, to: string) {
    await act(async () => {
      flow.props.onConnect({ source: from, target: to, sourceHandle: null, targetHandle: null });
      flow.props.onConnectEnd({ clientX: 40, clientY: 50 });
    });
  }

  it("class to class: is a kind of runs AddSubClassOf", async () => {
    await renderCanvas();
    await draw(EX + "Document", "http://xmlns.com/foaf/0.1/Agent");
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Document is a kind of Agent",
      "new relationship…",
      "Every Document has at least one… (a rule)",
    ]);
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Document is a kind of Agent" }));
    });
    expect(lastCommand()).toEqual(["AddSubClassOf", { child: EX + "Document", parent: "http://xmlns.com/foaf/0.1/Agent" }]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("a new relationship asks its name, then one CreateObjectProperty", async () => {
    await renderCanvas();
    await draw(EX + "Invoice", EX + "Document");
    fireEvent.click(screen.getByRole("menuitem", { name: "new relationship…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name of the new relationship" }), { target: { value: "copies" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(lastCommand()).toEqual([
      "CreateObjectProperty",
      { label: "copies", domain: EX + "Invoice", range: EX + "Document" },
    ]);
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("completes an existing relationship rather than bending one", async () => {
    await renderCanvas();
    await draw(EX + "Invoice", EX + "Document");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Invoice (en) mentions Document (existing relationship)" }));
    });
    // One command, so one undo step (relationships R6).
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(lastCommand()).toEqual(["SetEnds", { property: EX + "mentions", range: EX + "Document" }]);
    // The relationship it completed is selected, so its form opens.
    expect(onSelect).toHaveBeenLastCalledWith(EX + "mentions");
  });

  it("concept to concept: narrower than runs AddBroader", async () => {
    // Without the drawn Paid narrower than Status, which would make it a loop.
    await renderCanvas(viewOf({ edges: viewOf().edges.filter((e) => e.kind !== "broader") }));
    await draw(EX + "Status", EX + "Paid");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Status is narrower than Paid" }));
    });
    expect(lastCommand()).toEqual(["AddBroader", { concept: EX + "Status", broader: EX + "Paid" }]);
  });

  it("a class and a concept are refused with a sentence, and no menu opens", async () => {
    await renderCanvas();
    await draw(EX + "Document", EX + "Paid");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByText("A class and a concept cannot be linked here. Use the form for other annotations.")).toBeTruthy();
  });

  it("a refusal from the server stays in the menu as a sentence", async () => {
    runCommand.mockRejectedValueOnce(new Error("Document is already a subclass of Agent."));
    await renderCanvas();
    await draw(EX + "Document", "http://xmlns.com/foaf/0.1/Agent");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Document is a kind of Agent" }));
    });
    expect(within(document.querySelector(".relate-menu")!).getByRole("alert").textContent).toBe(
      "Document is already a subclass of Agent.",
    );
  });
});

describe("renaming, deleting, moving (AC-12, AC-13)", () => {
  it("Enter on a focused box renames it in the display language", async () => {
    await renderCanvas();
    const node = box("Document");
    node.focus();
    fireEvent.keyDown(node, { key: "Enter" });
    const field = screen.getByRole("textbox", { name: "New name for Document" });
    fireEvent.change(field, { target: { value: "Paper" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(lastCommand()).toEqual(["SetLabel", { iri: EX + "Document", value: "Paper", lang: "en" }]);
  });

  it("an imported box is not renamed or deleted", async () => {
    await renderCanvas();
    const node = box("Agent");
    fireEvent.keyDown(node, { key: "Enter" });
    fireEvent.keyDown(node, { key: "Delete" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Delete on a box opens the impact dialog, and deletes only on confirmation", async () => {
    previewDelete.mockResolvedValue({
      dryRun: true, revision: 2,
      impact: { iri: EX + "Document", label: "Document", kind: "class", statements: 4, strategy: "reparent",
        children: [{ iri: EX + "Invoice", label: "Invoice" }], reparentedTo: [], properties: [], individuals: [], importMentions: 0 },
    });
    await renderCanvas();
    await act(async () => {
      fireEvent.keyDown(box("Document"), { key: "Delete" });
    });
    const dialog = screen.getByRole("dialog", { name: "Delete Document?" });
    expect(runCommand).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    expect(lastCommand()).toEqual(["DeleteEntity", { iri: EX + "Document", strategy: "reparent" }]);
    expect(onDeleted).toHaveBeenCalledWith(EX + "Document");
  });

  it("a selected line and Delete removes that link", async () => {
    await renderCanvas();
    const edges = flow.props.edges as { id: string }[];
    await act(async () => flow.props.onEdgeClick({}, edges[0]));
    await act(async () => {
      fireEvent.keyDown(document.querySelector(".react-flow")!, { key: "Delete" });
    });
    expect(lastCommand()).toEqual(["RemoveSubClassOf", { child: EX + "Invoice", parent: EX + "Document" }]);
  });

  it("moving a box saves its place a second later, and is no command at all", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderCanvas();
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    putLayout.mockClear();
    await act(async () => {
      flow.props.onNodesChange([{ type: "position", id: EX + "Document", position: { x: 300, y: 40 }, dragging: false }]);
    });
    expect(putLayout).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(putLayout).toHaveBeenCalledTimes(1);
    expect(putLayout.mock.calls[0][2].positions[EX + "Document"]).toEqual([300, 40]);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("a refetch after a command keeps every box where it was", async () => {
    const { rerender } = await renderCanvas();
    await act(async () => {
      flow.props.onNodesChange([{ type: "position", id: EX + "Paid", position: { x: 777, y: 88 }, dragging: false }]);
    });
    getCanvas.mockResolvedValue(viewOf({ revision: 3 }));
    await act(async () => {
      rerender(
        <ModelCanvas projectId={PID} doc="model" revision={3} language="en" primaryLanguage="en" selected={null} onSelect={onSelect} onDeleted={onDeleted} />,
      );
    });
    await waitFor(() => expect(getCanvas).toHaveBeenCalledTimes(2));
    const paid = (flow.props.nodes as { id: string; position: { x: number; y: number } }[]).find((n) => n.id === EX + "Paid")!;
    expect(paid.position).toEqual({ x: 777, y: 88 });
  });
});

describe("selection is shared (AC-14)", () => {
  it("a click or a focused box selects; a selection made elsewhere pans here", async () => {
    const { rerender } = await renderCanvas();
    fireEvent.click(box("Document"));
    expect(onSelect).toHaveBeenLastCalledWith(EX + "Document");
    fireEvent.focus(box("Paid"));
    expect(onSelect).toHaveBeenLastCalledWith(EX + "Paid");
    await act(async () => {
      rerender(
        <ModelCanvas projectId={PID} doc="model" revision={2} language="en" primaryLanguage="en" selected={EX + "Paid"} onSelect={onSelect} onDeleted={onDeleted} />,
      );
    });
    expect(flow.props.nodes.find((n: { id: string }) => n.id === EX + "Paid").selected).toBe(true);
    // Paid was selected on the canvas itself: no pan to it.
    expect(flow.api.setCenter).not.toHaveBeenCalled();
    await act(async () => {
      rerender(
        <ModelCanvas projectId={PID} doc="model" revision={2} language="en" primaryLanguage="en" selected={EX + "Status"} onSelect={onSelect} onDeleted={onDeleted} />,
      );
    });
    expect(flow.api.setCenter).toHaveBeenCalled();
  });
});

describe("React Flow loads only with the canvas (AC-10)", () => {
  // Absolute, so every path names its folder: a relative glob gives this
  // folder's own files as "./X.tsx".
  const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const production = Object.entries(SOURCES).filter(([path]) => !/\.test\.(ts|tsx)$/.test(path));

  it("only canvas/ imports @xyflow/react, and App reaches canvas/ only through React.lazy", () => {
    expect(production.length).toBeGreaterThan(10);
    const flowImports = production.filter(([, text]) => text.includes('from "@xyflow/react"')).map(([p]) => p);
    expect(flowImports.length).toBeGreaterThan(0);
    expect(flowImports.every((p) => p.includes("/canvas/"))).toBe(true);
    const outside = production.filter(([p]) => !p.includes("/canvas/"));
    const staticCanvas = outside.filter(([, text]) => /from "\.\/canvas\/|from "\.\.\/canvas\//.test(text)).map(([p]) => p);
    expect(staticCanvas).toEqual([]);
    const app = production.find(([p]) => p.endsWith("/App.tsx"))![1];
    expect(app).toContain('lazy(() => import("./canvas/ModelCanvas"))');
  });
});

describe("found in the browser pass", () => {
  it("a deleted box that the dialog gives focus back to is not selected again", async () => {
    previewDelete.mockResolvedValue({
      dryRun: true, revision: 2,
      impact: { iri: EX + "Paid", label: "Paid", kind: "concept", statements: 3, strategy: "reparent",
        children: [], reparentedTo: [], properties: [], individuals: [], importMentions: 0 },
    });
    await renderCanvas();
    await act(async () => {
      fireEvent.keyDown(box("Paid"), { key: "Delete" });
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    });
    onSelect.mockClear();
    // Still drawn until the refetch; the dialog's focus return lands on it.
    fireEvent.focus(box("Paid"));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("connects in loose mode, so a line runs from where it started", async () => {
    await renderCanvas();
    expect(flow.props.connectionMode).toBe("loose");
  });

  it("a line leaves and enters by the sides facing each other", async () => {
    await renderCanvas(
      viewOf({
        layout: {
          version: 1,
          generation: 0,
          shown: null,
          viewport: null,
          positions: {
            [EX + "Invoice"]: [0, 0],
            [EX + "Document"]: [500, 0],
            [EX + "Paid"]: [0, 400],
            [EX + "Status"]: [0, 0],
            "http://xmlns.com/foaf/0.1/Agent": [0, -400],
          },
        },
      }),
    );
    const edges = flow.props.edges as { source: string; target: string; sourceHandle: string; targetHandle: string }[];
    const side = (s: string, t: string) => {
      const e = edges.find((x) => x.source === s && x.target === t)!;
      return [e.sourceHandle, e.targetHandle];
    };
    expect(side(EX + "Invoice", EX + "Document")).toEqual(["r", "l"]);
    expect(side(EX + "Paid", EX + "Status")).toEqual(["t", "b"]);
    expect(side(EX + "Invoice", "http://xmlns.com/foaf/0.1/Agent")).toEqual(["t", "b"]);
  });
});


describe("found in the code review of the branch", () => {
  function remount(rerender: (ui: React.ReactElement) => void, revision: number, selected: string | null = null) {
    return act(async () => {
      rerender(
        <ModelCanvas projectId={PID} doc="model" revision={revision} language="en" primaryLanguage="en" selected={selected} onSelect={onSelect} onDeleted={onDeleted} />,
      );
    });
  }

  it("a rename's moved entry is taken from the server, not overwritten by a stale copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const placed = { [EX + "Document"]: [0, 0], [EX + "Invoice"]: [5, 5], [EX + "Paid"]: [0, 300], [EX + "Status"]: [0, 500], "http://xmlns.com/foaf/0.1/Agent": [400, 0] } as Record<string, [number, number]>;
    const { rerender } = await renderCanvas(viewOf({ layout: { version: 1, generation: 0, positions: placed, shown: null, viewport: null } }));
    const renamed = viewOf({
      revision: 3,
      nodes: viewOf().nodes.map((n) => (n.iri === EX + "Invoice" ? { ...n, iri: EX + "Bill", label: "Bill" } : n)),
      edges: [],
      layout: {
        version: 1,
        // The rename's write: newer than any save this test made.
        generation: 99,
        positions: { ...Object.fromEntries(Object.entries(placed).filter(([k]) => k !== EX + "Invoice")), [EX + "Bill"]: [5, 5] },
        shown: null,
        viewport: null,
      },
    });
    getCanvas.mockResolvedValue(renamed);
    putLayout.mockClear();
    await remount(rerender, 3);
    await waitFor(() => expect(box("Bill")).toBeTruthy());
    const bill = (flow.props.nodes as { id: string; position: { x: number; y: number } }[]).find((n) => n.id === EX + "Bill")!;
    expect(bill.position).toEqual({ x: 5, y: 5 });
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    // Nothing to write: every box had its place, and no stale Invoice entry.
    for (const call of putLayout.mock.calls) expect(call[2].positions[EX + "Invoice"]).toBeUndefined();
  });

  it("the rename field starts on the name the box has now", async () => {
    const { rerender } = await renderCanvas();
    getCanvas.mockResolvedValue(viewOf({ revision: 3, nodes: viewOf().nodes.map((n) => (n.iri === EX + "Document" ? { ...n, label: "Paper" } : n)) }));
    await remount(rerender, 3);
    await waitFor(() => expect(box("Paper")).toBeTruthy());
    fireEvent.keyDown(box("Paper"), { key: "Enter" });
    expect((screen.getByRole("textbox", { name: "New name for Paper" }) as HTMLInputElement).value).toBe("Paper");
  });

  it("only a fallback's marker is taken off; a fallback starts empty", async () => {
    await renderCanvas(
      viewOf({ nodes: [{ iri: EX + "Draft", kind: "class", label: "Invoice (draft)", fallback: false, attributes: [] }, ...viewOf().nodes] }),
    );
    fireEvent.keyDown(box("Invoice (draft)"), { key: "Enter" });
    expect((screen.getByRole("textbox", { name: "New name for Invoice (draft)" }) as HTMLInputElement).value).toBe("Invoice (draft)");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New name for Invoice (draft)" }), { key: "Escape" });
    fireEvent.keyDown(box("Invoice (en)"), { key: "Enter" });
    const field = screen.getByRole("textbox", { name: "New name for Invoice (en)" }) as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("Invoice (en)");
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("a button inside a box keeps its own keys", async () => {
    await renderCanvas();
    const add = within(box("Document")).getByRole("button", { name: "Add an attribute to Document" });
    fireEvent.keyDown(add, { key: "Enter" });
    expect(screen.queryByRole("textbox", { name: "New name for Document" })).toBeNull();
    fireEvent.keyDown(add, { key: "Backspace" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an emptied chosen set stays empty, and a selected property is not shown as a box", async () => {
    await renderCanvas(
      viewOf({ limited: true, nodes: [], edges: [], layout: { version: 1, generation: 0, positions: {}, shown: [], viewport: null } }),
      EX + "Invoice",
    );
    await act(async () => undefined);
    expect(putLayout).not.toHaveBeenCalled();
    cleanup();
    getNodeDetails.mockResolvedValue({ iri: EX + "mentions", kind: "objectProperty" });
    await renderCanvas(viewOf({ limited: true, nodes: [], edges: [] }), EX + "mentions");
    await act(async () => undefined);
    expect(putLayout).not.toHaveBeenCalled();
  });

  it("a second refused rename shows its own sentence, not the first", async () => {
    runCommand.mockRejectedValueOnce(new Error("First refusal.")).mockRejectedValueOnce(new Error("Second refusal."));
    await renderCanvas();
    fireEvent.keyDown(box("Document"), { key: "Enter" });
    const field = screen.getByRole("textbox", { name: "New name for Document" });
    fireEvent.change(field, { target: { value: "X" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(screen.getByText("First refusal.")).toBeTruthy();
    fireEvent.change(field, { target: { value: "Y" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    expect(screen.getByText("Second refusal.")).toBeTruthy();
  });

  it("a box restored by undo can be selected by focus again", async () => {
    previewDelete.mockResolvedValue({
      dryRun: true, revision: 2,
      impact: { iri: EX + "Paid", label: "Paid", kind: "concept", statements: 3, strategy: "reparent",
        children: [], reparentedTo: [], properties: [], individuals: [], importMentions: 0 },
    });
    const { rerender } = await renderCanvas();
    await act(async () => {
      fireEvent.keyDown(box("Paid"), { key: "Delete" });
    });
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    });
    getCanvas.mockResolvedValue(viewOf({ revision: 3, nodes: viewOf().nodes.filter((n) => n.iri !== EX + "Paid"), edges: [] }));
    await remount(rerender, 3);
    await waitFor(() => expect(box("Paid")).toBeUndefined());
    getCanvas.mockResolvedValue(viewOf({ revision: 4 }));
    await remount(rerender, 4);
    await waitFor(() => expect(box("Paid")).toBeTruthy());
    onSelect.mockClear();
    fireEvent.focus(box("Paid"));
    expect(onSelect).toHaveBeenCalledWith(EX + "Paid");
  });
});

describe("PR #47 review", () => {
  function later<T>() {
    let resolve: (value: T) => void = () => {};
    let reject: (e: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("1: a box made on the canvas keeps its drop point through a refetch that beats its save", async () => {
    runCommand.mockResolvedValueOnce({ revision: 3, label: "Created class Receipt", state: STATE, created: EX + "Receipt" });
    const { rerender } = await renderCanvas();
    const pending = later<unknown>();
    putLayout.mockImplementation(() => pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Class" }));
    const field = screen.getByRole("textbox", { name: "Name of the new class" });
    fireEvent.change(field, { target: { value: "Receipt" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    const dropped = putLayout.mock.calls[putLayout.mock.calls.length - 1][2].positions[EX + "Receipt"];
    // The refetch reads the layout before the save has landed: no Receipt.
    getCanvas.mockResolvedValue(
      viewOf({
        revision: 3,
        nodes: [...viewOf().nodes, { iri: EX + "Receipt", kind: "class", label: "Receipt", fallback: false, attributes: [] }],
      }),
    );
    await act(async () => {
      rerender(<ModelCanvas projectId={PID} doc="model" revision={3} language="en" primaryLanguage="en" selected={null} onSelect={onSelect} onDeleted={onDeleted} />);
    });
    await waitFor(() => expect(box("Receipt")).toBeTruthy());
    const receipt = (flow.props.nodes as { id: string; position: { x: number; y: number } }[]).find((n) => n.id === EX + "Receipt")!;
    expect([receipt.position.x, receipt.position.y]).toEqual(dropped);
    await act(async () => pending.resolve({}));
  });

  it("2: closing the project waits for a move's pending save", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderCanvas();
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    putLayout.mockClear();
    const order: string[] = [];
    putLayout.mockImplementation(async (_p, _d, layout) => {
      order.push("layout");
      return layout;
    });
    closeProject.mockImplementation(async () => {
      order.push("close");
      return { closed: PID };
    });
    await act(async () => {
      flow.props.onNodesChange([{ type: "position", id: EX + "Document", position: { x: 42, y: 7 }, dragging: false }]);
    });
    // Less than a second later: Close.
    await act(async () => projectStore.close());
    expect(order).toEqual(["layout", "close"]);
    expect(putLayout.mock.calls[0][2].positions[EX + "Document"]).toEqual([42, 7]);
  });

  it("3: Delete reaches a selected line: the click puts focus where the key is handled", async () => {
    await renderCanvas();
    const edges = flow.props.edges as { id: string; ariaLabel: string }[];
    await act(async () => flow.props.onEdgeClick({}, edges[0]));
    expect(document.activeElement?.classList.contains("canvas-surface")).toBe(true);
    expect(screen.getByText("Invoice (en) is a kind of Document selected. Delete removes it.")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    });
    expect(lastCommand()).toEqual(["RemoveSubClassOf", { child: EX + "Invoice", parent: EX + "Document" }]);
  });

  it("3: Delete on a selected relationship line opens the delete flow for its property", async () => {
    previewDelete.mockResolvedValue({
      dryRun: true, revision: 2,
      impact: { iri: EX + "billedTo", label: "billed to", kind: "object property", statements: 4, strategy: "reparent",
        children: [], reparentedTo: [], properties: [], individuals: [], importMentions: 0 },
    });
    await renderCanvas();
    const edges = flow.props.edges as { id: string }[];
    await act(async () => flow.props.onEdgeClick({}, edges[2]));
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    });
    expect(screen.getByRole("dialog", { name: "Delete billed to?" })).toBeTruthy();
    expect(previewDelete).toHaveBeenCalledWith(PID, "model", EX + "billedTo", "reparent");
  });

  it("5: a move stays unsaved until a save succeeds, and a failed save says so", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender } = await renderCanvas();
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    putLayout.mockRejectedValueOnce(new Error("The disk is full."));
    await act(async () => {
      flow.props.onNodesChange([{ type: "position", id: EX + "Paid", position: { x: 900, y: 9 }, dragging: false }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(1100);
    });
    expect(screen.getByText(/The canvas layout could not be saved: The disk is full\./)).toBeTruthy();
    // A refetch that does not know the move keeps it.
    getCanvas.mockResolvedValue(viewOf({ revision: 3 }));
    await act(async () => {
      rerender(<ModelCanvas projectId={PID} doc="model" revision={3} language="en" primaryLanguage="en" selected={null} onSelect={onSelect} onDeleted={onDeleted} />);
    });
    await waitFor(() => expect(getCanvas).toHaveBeenCalledTimes(2));
    const paid = (flow.props.nodes as { id: string; position: { x: number; y: number } }[]).find((n) => n.id === EX + "Paid")!;
    expect(paid.position).toEqual({ x: 900, y: 9 });
    // The next save carries it, and the sentence goes.
    putLayout.mockClear();
    await act(async () => projectStore.flushAll());
    expect(putLayout.mock.calls[0][2].positions[EX + "Paid"]).toEqual([900, 9]);
    expect(screen.queryByText(/could not be saved/)).toBeNull();
  });

  it("6: a form edit does not re-centre the canvas; a new selection does", async () => {
    const { rerender } = await renderCanvas();
    const props = { projectId: PID, doc: "model" as const, language: "en", primaryLanguage: "en", onSelect, onDeleted };
    await act(async () => {
      rerender(<ModelCanvas {...props} revision={2} selected={EX + "Status"} />);
    });
    expect(flow.api.setCenter).toHaveBeenCalledTimes(1);
    // An edit in the form: a new revision, positions rebuilt, same selection.
    getCanvas.mockResolvedValue(viewOf({ revision: 3 }));
    await act(async () => {
      rerender(<ModelCanvas {...props} revision={3} selected={EX + "Status"} />);
    });
    await waitFor(() => expect(getCanvas).toHaveBeenCalledTimes(2));
    expect(flow.api.setCenter).toHaveBeenCalledTimes(1);
    await act(async () => {
      rerender(<ModelCanvas {...props} revision={3} selected={EX + "Paid"} />);
    });
    expect(flow.api.setCenter).toHaveBeenCalledTimes(2);
  });

  it("7: a failed Show on canvas changes nothing, rejects nothing, and says so", async () => {
    await renderCanvas(viewOf({ limited: true, nodes: [], edges: [], layout: { version: 1, generation: 0, positions: {}, shown: [], viewport: null } }));
    const set = onCanvasSet.mock.calls[onCanvasSet.mock.calls.length - 1][0];
    putLayout.mockRejectedValueOnce(new Error("Refused."));
    getCanvas.mockClear();
    await act(async () => {
      await expect(set.show(EX + "Invoice")).resolves.toBeUndefined();
    });
    expect(screen.getByText("The canvas could not change what it shows: Refused.")).toBeTruthy();
    const after = onCanvasSet.mock.calls[onCanvasSet.mock.calls.length - 1][0];
    expect(after.shown).toEqual([]);
    expect(getCanvas).not.toHaveBeenCalled();
  });

  it("8: Tidy up is aria-disabled, not disabled, with nothing to tidy", async () => {
    await renderCanvas(viewOf({ nodes: [], edges: [], undrawn: [], total: 0 }));
    const tidy = screen.getByRole("button", { name: "Tidy up" }) as HTMLButtonElement;
    expect(tidy.disabled).toBe(false);
    expect(tidy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(tidy);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("9: past 300 boxes only a class or a concept is added to the shown set", async () => {
    getNodeDetails.mockResolvedValue({ iri: EX + "billedTo", kind: "objectProperty" });
    await renderCanvas(viewOf({ limited: true, nodes: [], edges: [] }), EX + "billedTo");
    await act(async () => undefined);
    expect(getNodeDetails).toHaveBeenCalledWith(`${PID}-model`, EX + "billedTo");
    expect(putLayout).not.toHaveBeenCalled();
    cleanup();
    getNodeDetails.mockResolvedValue({ iri: EX + "Paid", kind: "concept" });
    await renderCanvas(viewOf({ limited: true, nodes: [], edges: [] }), EX + "Paid");
    await waitFor(() => expect(putLayout).toHaveBeenCalled());
    expect(putLayout.mock.calls[0][2].shown).toEqual([EX + "Paid"]);
  });
});

describe("PR #47 re-review: responses in any order", () => {
  function later<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  it("a refetch that read the layout before the drop's save cannot move the new box", async () => {
    runCommand.mockResolvedValueOnce({ revision: 3, label: "Created class Receipt", state: STATE, created: EX + "Receipt" });
    const { rerender } = await renderCanvas();
    // The next GET and PUT are held, to be answered in the order that lost
    // the drop point in Chrome.
    const get = later<CanvasView>();
    const put = later<CanvasLayout>();
    getCanvas.mockImplementationOnce(() => get.promise);
    putLayout.mockImplementationOnce(() => put.promise);
    fireEvent.click(screen.getByRole("button", { name: "Class" }));
    const field = screen.getByRole("textbox", { name: "Name of the new class" });
    fireEvent.change(field, { target: { value: "Receipt" } });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
    });
    const sent = putLayout.mock.calls[putLayout.mock.calls.length - 1][2];
    const dropped = sent.positions[EX + "Receipt"];
    // The create's refetch goes out and reads the layout on the server now,
    // before the PUT has written it: generation 0, and no Receipt.
    await act(async () => {
      rerender(<ModelCanvas projectId={PID} doc="model" revision={3} language="en" primaryLanguage="en" selected={null} onSelect={onSelect} onDeleted={onDeleted} />);
    });
    // The PUT is answered first: generation 1, the box settled.
    await act(async () => put.resolve({ ...sent, generation: 1 }));
    // Then the older GET arrives, without the box's position.
    await act(async () =>
      get.resolve(
        viewOf({
          revision: 3,
          nodes: [...viewOf().nodes, { iri: EX + "Receipt", kind: "class", label: "Receipt", fallback: false, attributes: [] }],
        }),
      ),
    );
    await waitFor(() => expect(box("Receipt")).toBeTruthy());
    const receipt = (flow.props.nodes as { id: string; position: { x: number; y: number } }[]).find((n) => n.id === EX + "Receipt")!;
    expect([receipt.position.x, receipt.position.y]).toEqual(dropped);
    // And nothing re-placed it and saved that instead.
    for (const call of putLayout.mock.calls.slice(putLayout.mock.calls.indexOf(putLayout.mock.calls.find((c) => c[2] === sent)!) + 1)) {
      expect(call[2].positions[EX + "Receipt"]).toEqual(dropped);
    }
  });

  it("a newer layout, such as a rename's move, is still taken", async () => {
    const { rerender } = await renderCanvas();
    getCanvas.mockResolvedValue(
      viewOf({
        revision: 3,
        nodes: viewOf().nodes.map((n) => (n.iri === EX + "Paid" ? { ...n, iri: EX + "Settled", label: "Settled" } : n)),
        layout: { version: 1, generation: 50, positions: { [EX + "Settled"]: [321, 123] }, shown: null, viewport: null },
      }),
    );
    await act(async () => {
      rerender(<ModelCanvas projectId={PID} doc="model" revision={3} language="en" primaryLanguage="en" selected={null} onSelect={onSelect} onDeleted={onDeleted} />);
    });
    await waitFor(() => expect(box("Settled")).toBeTruthy());
    const settled = (flow.props.nodes as { id: string; position: { x: number; y: number } }[]).find((n) => n.id === EX + "Settled")!;
    expect(settled.position).toEqual({ x: 321, y: 123 });
  });
});

describe("relationships Stage A: seeing and drawing relationships", () => {
  async function draw(from: string, to: string) {
    await act(async () => {
      flow.props.onConnect({ source: from, target: to, sourceHandle: null, targetHandle: null });
      flow.props.onConnectEnd({ clientX: 40, clientY: 50 });
    });
  }
  const edge = (kind: string) => (flow.props.edges as any[]).find((e) => e.id.startsWith(kind));

  it("a click on a relationship's line selects the relationship (AC-3)", async () => {
    await renderCanvas();
    await act(async () => flow.props.onEdgeClick({}, edge("relationship")));
    expect(onSelect).toHaveBeenLastCalledWith(EX + "billedTo");
    expect(onSelectLink).not.toHaveBeenCalled();
    // Delete still removes it, through the impact dialog, as before.
    expect(screen.getByRole("status").textContent).toContain("selected. Delete removes it.");
  });

  it("a click on a subclass or broader line opens the link panel (AC-3)", async () => {
    await renderCanvas();
    await act(async () => flow.props.onEdgeClick({}, edge("subClassOf")));
    expect(onSelectLink).toHaveBeenLastCalledWith({
      kind: "subClassOf", source: EX + "Invoice", target: EX + "Document", sourceLabel: "Invoice (en)", targetLabel: "Document",
    });
    await act(async () => flow.props.onEdgeClick({}, edge("broader")));
    expect(onSelectLink).toHaveBeenLastCalledWith({
      kind: "broader", source: EX + "Paid", target: EX + "Status", sourceLabel: "Paid", targetLabel: "Status",
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("a relationship's line is lit while the relationship is selected, however it was", async () => {
    await renderCanvas(viewOf(), EX + "billedTo");
    expect(edge("relationship").selected).toBe(true);
    expect(edge("subClassOf").selected).toBe(false);
  });

  it("a new relationship is selected once created, and announced as a sentence (AC-3)", async () => {
    runCommand.mockImplementation(async (_p, _d, command: string) => ({
      revision: 3, label: command, state: STATE, created: EX + "copies",
    }));
    await renderCanvas();
    await draw(EX + "Invoice", EX + "Document");
    fireEvent.click(screen.getByRole("menuitem", { name: "new relationship…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name of the new relationship" }), { target: { value: "copies" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(onSelect).toHaveBeenLastCalledWith(EX + "copies");
    expect(projectStore.getSnapshot().announcement.text).toBe(
      "Created relationship copies, from Invoice (en) to Document.",
    );
  });

  it("the relate menu is headed by its two ends and swaps them before anything is made (AC-4)", async () => {
    await renderCanvas();
    await draw(EX + "Document", EX + "Invoice");
    const menu = document.querySelector<HTMLElement>(".relate-menu")!;
    expect(menu.querySelector(".relate-title")!.textContent).toBe("Document …to Invoice (en)");
    expect(within(menu).getByRole("menuitem", { name: "Document is a kind of Invoice (en)" })).toBeTruthy();
    fireEvent.click(within(menu).getByRole("button", { name: "Swap: from Invoice (en) to Document" }));
    expect(menu.querySelector(".relate-title")!.textContent).toBe("Invoice (en) …to Document");
    // Invoice is already a kind of Document, so that is not offered again;
    // what the swapped line would complete is.
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "new relationship…",
      "Every Invoice (en) has at least one… (a rule)",
      "Invoice (en) mentions Document (existing relationship)",
    ]);
    expect(runCommand).not.toHaveBeenCalled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "new relationship…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name of the new relationship" }), { target: { value: "copies" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
    });
    expect(lastCommand()).toEqual(["CreateObjectProperty", { label: "copies", domain: EX + "Invoice", range: EX + "Document" }]);
  });

  it("naming shows the sentence as typed, joined to the field (AC-4)", async () => {
    await renderCanvas();
    await draw(EX + "Document", EX + "Invoice");
    fireEvent.click(screen.getByRole("menuitem", { name: "new relationship…" }));
    const field = screen.getByRole("textbox", { name: "Name of the new relationship" });
    const sentence = () => document.getElementById(field.getAttribute("aria-describedby")!)!.textContent;
    expect(sentence()).toBe("A Document … an Invoice (en).");
    fireEvent.change(field, { target: { value: "cites" } });
    expect(sentence()).toBe("A Document cites an Invoice (en).");
  });

  it("a class linked to itself offers a relationship and never is a kind of (R5)", async () => {
    await renderCanvas();
    await draw(EX + "Document", EX + "Document");
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "new relationship…",
      "Every Document has at least one… (a rule)",
    ]);
  });

  it("lines sharing two boxes carry their place, and a loop leaves on the right and enters the top (AC-5)", async () => {
    await renderCanvas(
      viewOf({
        edges: [
          { kind: "relationship", source: EX + "Invoice", target: EX + "Document", property: EX + "a", label: "a", pair: 0, pairs: 2 },
          { kind: "relationship", source: EX + "Document", target: EX + "Invoice", property: EX + "b", label: "b", pair: 1, pairs: 2 },
          { kind: "relationship", source: EX + "Document", target: EX + "Document", property: EX + "c", label: "c", pair: 0, pairs: 1 },
        ],
      }),
    );
    const [a, b, c] = flow.props.edges as any[];
    expect([a.data.pair, a.data.pairs, b.data.pair, b.data.pairs]).toEqual([0, 2, 1, 2]);
    // Both directions in one frame: one runs with the pair's order, one against.
    expect(a.data.forward).not.toBe(b.data.forward);
    expect([c.sourceHandle, c.targetHandle]).toEqual(["r", "t"]);
    expect(c.data.text).toBe("c");
  });
});

describe("relationships Stage A: the project's kind (AC-2)", () => {
  it("an ontology offers Class only and marks its concepts read-only, with the note", async () => {
    await renderCanvas(viewOf({ kind: "ontology" }));
    const palette = screen.getByRole("toolbar", { name: "Canvas" });
    expect(within(palette).queryByRole("button", { name: "Class" })).toBeTruthy();
    expect(within(palette).queryByRole("button", { name: "Concept" })).toBeNull();
    expect(
      screen.getByText("This ontology also contains 2 SKOS concepts. Edit them in Turtle, or change the project to a taxonomy."),
    ).toBeTruthy();
    expect(box("Paid").querySelector(".canvas-box")!.classList.contains("other-kind")).toBe(true);
    expect(box("Paid").textContent).toContain("read-only in an ontology");
    // Not renamed or deleted here: the keys say where instead.
    fireEvent.keyDown(box("Paid"), { key: "Enter" });
    fireEvent.keyDown(box("Paid"), { key: "Delete" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("read-only in an ontology");
  });

  it("an ontology refuses a line between its concepts, with where to change them", async () => {
    await renderCanvas(viewOf({ kind: "ontology" }));
    await draw(EX + "Status", EX + "Paid");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(
      "Status is a SKOS concept, read-only in an ontology. Edit it in Turtle, or change the project to a taxonomy.",
    );
  });

  it("a taxonomy offers Concept only, and its classes lose + attribute", async () => {
    await renderCanvas(viewOf({ kind: "taxonomy" }));
    const palette = screen.getByRole("toolbar", { name: "Canvas" });
    expect(within(palette).queryByRole("button", { name: "Class" })).toBeNull();
    expect(within(palette).queryByRole("button", { name: "Concept" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add an attribute to Document" })).toBeNull();
    expect(screen.getByText(/This taxonomy also contains 2 classes\./)).toBeTruthy();
  });

  it("a link between boxes of the other kind is not removed here, by Delete or the panel (review)", async () => {
    await renderCanvas(viewOf({ kind: "ontology" }));
    const broader = (flow.props.edges as any[]).find((e) => e.id.startsWith("broader"));
    await act(async () => flow.props.onEdgeClick({}, broader));
    const reason = "Paid is a SKOS concept, read-only in an ontology. Edit it in Turtle, or change the project to a taxonomy.";
    expect(onSelectLink).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "broader", readOnly: reason }));
    await act(async () => {
      fireEvent.keyDown(document.querySelector(".react-flow")!, { key: "Delete" });
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toBe(reason);
  });

  it("with no other kind present, there is no note", async () => {
    await renderCanvas(viewOf({ kind: "taxonomy", nodes: viewOf().nodes.filter((n) => n.kind === "concept"), edges: [] }));
    expect(document.querySelector(".canvas-other-kind")).toBeNull();
  });

  async function draw(from: string, to: string) {
    await act(async () => {
      flow.props.onConnect({ source: from, target: to, sourceHandle: null, targetHandle: null });
      flow.props.onConnectEnd({ clientX: 40, clientY: 50 });
    });
  }
});

describe("relationships Stage B: related lines and the Stage A follow-ups (5.8, 5.10)", () => {
  async function draw(from: string, to: string) {
    await act(async () => {
      flow.props.onConnect({ source: from, target: to, sourceHandle: null, targetHandle: null });
      flow.props.onConnectEnd({ clientX: 40, clientY: 50 });
    });
  }
  const edge = (kind: string) => (flow.props.edges as any[]).find((e) => e.id.startsWith(kind));
  const related = { kind: "related" as const, source: EX + "Paid", target: EX + "Status", pair: 0, pairs: 1 };
  const withRelated = () => viewOf({ edges: [...viewOf().edges, related] });
  const rerenderWith = async (rerender: (ui: React.ReactElement) => void, selected: string | null) => {
    await act(async () => {
      rerender(
        <ModelCanvas
          projectId={PID}
          doc="model"
          revision={2}
          language="en"
          primaryLanguage="en"
          selected={selected}
          onSelect={onSelect}
          onSelectLink={onSelectLink}
          onDeleted={onDeleted}
        />,
      );
    });
  };

  it("draws related to dashed, with no arrowhead, named as a sentence (R17)", async () => {
    await renderCanvas(withRelated());
    const line = edge("related");
    expect(line.data.dashed).toBe(true);
    expect(line.markerEnd).toBeUndefined();
    expect(line.ariaLabel).toBe("Paid is related to Status");
    expect(line.data.text).toBe("related to");
    expect(edge("broader").data.dashed).toBe(false);
  });

  it("concept to concept offers related to, which runs AddRelated", async () => {
    await renderCanvas(viewOf({ edges: [] }));
    await draw(EX + "Paid", EX + "Status");
    expect(screen.getAllByRole("menuitem").map((m) => m.textContent)).toEqual([
      "Paid is narrower than Status",
      "Paid is related to Status",
    ]);
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Paid is related to Status" }));
    });
    expect(lastCommand()).toEqual(["AddRelated", { concept: EX + "Paid", related: EX + "Status" }]);
  });

  it("a server refusal of related to stays in the menu as its sentence (R18)", async () => {
    await renderCanvas(viewOf({ edges: [] }));
    await draw(EX + "Status", EX + "Paid");
    const sentence = "Paid is already narrower than Status; SKOS does not allow them to be related as well.";
    runCommand.mockRejectedValueOnce(new Error(sentence));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Status is related to Paid" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(sentence);
  });

  it("a related line opens the link panel, and Delete removes it both ways in one command", async () => {
    await renderCanvas(withRelated());
    await act(async () => flow.props.onEdgeClick({}, edge("related")));
    expect(onSelectLink).toHaveBeenLastCalledWith({
      kind: "related", source: EX + "Paid", target: EX + "Status", sourceLabel: "Paid", targetLabel: "Status",
    });
    await act(async () => {
      fireEvent.keyDown(document.querySelector(".react-flow")!, { key: "Delete" });
    });
    expect(lastCommand()).toEqual(["RemoveRelated", { concept: EX + "Paid", related: EX + "Status" }]);
  });

  it("item 1: a selected line's highlight goes when a box or a tree row is selected", async () => {
    const { rerender } = await renderCanvas();
    await act(async () => flow.props.onEdgeClick({}, edge("subClassOf")));
    expect(edge("subClassOf").selected).toBe(true);
    await rerenderWith(rerender, EX + "Document");
    expect(edge("subClassOf").selected).toBe(false);
  });

  it("item 1: a relationship's line stays lit while it is the selection, and not after", async () => {
    const { rerender } = await renderCanvas();
    await act(async () => flow.props.onEdgeClick({}, edge("relationship")));
    // Its own click must not clear it before App's selection arrives.
    expect(edge("relationship").selected).toBe(true);
    await rerenderWith(rerender, EX + "billedTo");
    expect(edge("relationship").selected).toBe(true);
    await rerenderWith(rerender, EX + "Invoice");
    expect(edge("relationship").selected).toBe(false);
  });

  it("item 2: in a taxonomy a relationship's line is read-only, by Delete and the form's note", async () => {
    await renderCanvas(viewOf({ kind: "taxonomy" }));
    await act(async () => flow.props.onEdgeClick({}, edge("relationship")));
    expect(onSelect).toHaveBeenLastCalledWith(EX + "billedTo");
    const reason = "billed to is a relationship, read-only in a taxonomy. Edit it in Turtle, or change the project to an ontology.";
    expect(screen.getByRole("status").textContent).toBe(reason);
    await act(async () => {
      fireEvent.keyDown(document.querySelector(".react-flow")!, { key: "Delete" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("item 3: a box added by clicking the palette lands clear of every box", async () => {
    runCommand.mockResolvedValueOnce({ revision: 3, label: "Created class Receipt", state: STATE, created: EX + "Receipt" });
    await renderCanvas();
    const taken = (flow.props.nodes as { position: { x: number; y: number } }[]).map((n) => n.position);
    fireEvent.click(screen.getByRole("button", { name: "Class" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name of the new class" }), { target: { value: "Receipt" } });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Name of the new class" }), { key: "Enter" });
    });
    const saved = putLayout.mock.calls[putLayout.mock.calls.length - 1][2];
    const [x, y] = saved.positions[EX + "Receipt"];
    for (const p of taken) {
      expect(Math.abs(p.x - x) >= 190 || Math.abs(p.y - y) >= 90).toBe(true);
    }
  });

  it("item 4: the menu for a loop has no Swap and no notes about other lines", async () => {
    await renderCanvas();
    await draw(EX + "Invoice", EX + "Invoice");
    expect(screen.queryByRole("button", { name: /^Swap/ })).toBeNull();
    expect(document.querySelector(".relate-menu")!.textContent).not.toContain("already links");
  });

  it("item 6: a link whose narrower end is imported is shown read-only in the panel", async () => {
    await renderCanvas(
      viewOf({
        edges: [{ kind: "subClassOf", source: "http://xmlns.com/foaf/0.1/Agent", target: EX + "Document", pair: 0, pairs: 1 }],
      }),
    );
    await act(async () => flow.props.onEdgeClick({}, edge("subClassOf")));
    expect(onSelectLink).toHaveBeenLastCalledWith(
      expect.objectContaining({
        readOnly: "Agent comes from FOAF and is read-only; this link is changed where it is defined.",
      }),
    );
    await act(async () => {
      fireEvent.keyDown(document.querySelector(".react-flow")!, { key: "Delete" });
    });
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("item 7: a click on a line's label is a click on its line", async () => {
    await renderCanvas();
    await act(async () => edge("relationship").data.onLabel(edge("relationship").id));
    expect(onSelect).toHaveBeenLastCalledWith(EX + "billedTo");
    await act(async () => edge("subClassOf").data.onLabel(edge("subClassOf").id));
    expect(onSelectLink).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "subClassOf" }));
  });

  it("5.7: an attribute row in a box opens the attribute, not the class", async () => {
    await renderCanvas();
    fireEvent.click(within(box("Invoice (en)")).getByRole("button", { name: "total : xsd:decimal" }));
    expect(onSelect).toHaveBeenLastCalledWith(EX + "total");
    expect(onSelect).not.toHaveBeenCalledWith(EX + "Invoice");
  });
});

describe("inferred lines and boxes (axioms-and-reasoning 5.7)", () => {
  // Invoice is concluded a kind of Agent; Document can never have members.
  const reasoned = () =>
    viewOf({
      nodes: viewOf().nodes.map((n) => (n.iri === EX + "Document" ? { ...n, neverMembers: true } : n)),
      edges: [
        ...viewOf().edges,
        { kind: "subClassOf", source: EX + "Invoice", target: "http://xmlns.com/foaf/0.1/Agent", pair: 1, pairs: 2, inferred: true },
      ],
    });

  async function renderInferred(inferred: { imports: boolean } | null) {
    getCanvas.mockResolvedValue(reasoned());
    const result = render(
      <ModelCanvas
        projectId={PID}
        doc="model"
        revision={2}
        language="en"
        primaryLanguage="en"
        selected={null}
        onSelect={onSelect}
        onSelectLink={onSelectLink}
        onDeleted={onDeleted}
        onCanvasSet={onCanvasSet}
        inferred={inferred}
      />,
    );
    await waitFor(() => expect(document.querySelectorAll(".react-flow__node")).toHaveLength(5));
    return result;
  }

  const inferredLine = () => (flow.props.edges as any[]).find((e) => e.data.inferred);

  it("asks for them, draws the line dashed and labelled inferred, and says so on the box", async () => {
    await renderInferred({ imports: false });
    expect(getCanvas).toHaveBeenCalledWith(PID, "model", { imports: false });
    const line = inferredLine();
    expect(line.ariaLabel).toBe("Invoice (en) is a kind of Agent, inferred");
    // The word, always shown, and the dash: never colour alone.
    expect(line.data.text).toBe("inferred");
    expect(line.data.always).toBe(true);
    expect(within(box("Document")).getByText("can never have members")).toBeTruthy();
    expect(box("Document").querySelector(".canvas-box")!.classList.contains("never-members")).toBe(true);
    expect(within(box("Invoice (en)")).queryByText("can never have members")).toBeNull();
  });

  it("never removes an inferred line: Delete says why and changes nothing", async () => {
    await renderInferred({ imports: false });
    await act(async () => flow.props.onEdgeClick({}, inferredLine()));
    expect(screen.getByText(/inferred by reasoning: a conclusion, not part of your model, so it is not removed here/)).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(onSelectLink).not.toHaveBeenCalled();
  });

  it("drops the marks at once when they go, before the refetch answers", async () => {
    const { rerender } = await renderInferred({ imports: false });
    expect(inferredLine()).toBeTruthy();
    // Stale, or Show inferred off: before any refetch answers.
    getCanvas.mockReturnValue(new Promise(() => {}));
    rerender(
      <ModelCanvas
        projectId={PID}
        doc="model"
        revision={2}
        language="en"
        primaryLanguage="en"
        selected={null}
        onSelect={onSelect}
        onSelectLink={onSelectLink}
        onDeleted={onDeleted}
        onCanvasSet={onCanvasSet}
        inferred={null}
      />,
    );
    expect(inferredLine()).toBeUndefined();
    expect(within(box("Document")).queryByText("can never have members")).toBeNull();
    expect(getCanvas).toHaveBeenLastCalledWith(PID, "model", null);
  });
});

describe("rule lines and boxes (axioms-and-reasoning 5.9, AC-11)", () => {
  const someKey = { form: "every" as const, property: EX + "hasLine", kind: "some" as const, filler: EX + "Document", n: null };
  const ruled = () =>
    viewOf({
      nodes: viewOf().nodes.map((n) =>
        n.iri === EX + "Invoice"
          ? { ...n, disjoint: [{ iri: EX + "Document", label: "Document" }], moreRules: 1 }
          : n,
      ),
      edges: [
        ...viewOf().edges,
        {
          kind: "rule", source: EX + "Invoice", target: EX + "Document", pair: 1, pairs: 3,
          rule: { form: "every", kind: "some", n: null, property: EX + "hasLine", propertyLabel: "has line", fillerLabel: "Document", withLabel: null },
          key: someKey,
        },
        {
          kind: "rule", source: EX + "Invoice", target: EX + "Document", pair: 2, pairs: 3,
          rule: { form: "defines", kind: "some", n: null, property: EX + "hasLine", propertyLabel: "has line", fillerLabel: "Document", withLabel: "Agent" },
          key: { ...someKey, form: "defines" as const, with: "http://xmlns.com/foaf/0.1/Agent" },
        },
      ],
    });
  const rules = () => (flow.props.edges as any[]).filter((e) => e.data.rule);

  it("draws each rule as a dashed line labelled with its short form, read as its sentence", async () => {
    await renderCanvas(ruled());
    const [every, defines] = rules();
    expect(every.data.text).toBe("at least 1 · has line");
    expect(every.data.always).toBe(true);
    expect(every.ariaLabel).toBe("Every Invoice (en) has at least one has line that is a Document, a rule");
    expect(defines.data.text).toBe("defines");
    expect(defines.ariaLabel).toBe("An Invoice (en) is exactly an Agent that has line at least one Document, a rule");
    // Two rules on the same two boxes are two lines.
    expect(every.id).not.toBe(defines.id);
  });

  it("writes disjointness in the box and counts the rules it does not draw", async () => {
    await renderCanvas(ruled());
    expect(within(box("Invoice (en)")).getByText("never a Document")).toBeTruthy();
    expect(within(box("Invoice (en)")).getByText("1 more rule in the form")).toBeTruthy();
    expect(box("Invoice (en)").getAttribute("aria-label")).toBe(
      "Invoice (en), class, kind of Document, never a Document, 1 more rule in the form",
    );
  });

  it("a click on a rule selects its class; Delete removes it by its key", async () => {
    await renderCanvas(ruled());
    await act(async () => flow.props.onEdgeClick({}, rules()[0]));
    expect(onSelect).toHaveBeenCalledWith(EX + "Invoice");
    expect(screen.getByText("Every Invoice (en) has at least one has line that is a Document selected. Delete removes it.")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    });
    expect(lastCommand()).toEqual(["RemoveRestriction", { class: EX + "Invoice", restriction: someKey }]);
  });

  it("the relate menu's rule entry selects the class and opens its builder through the store", async () => {
    await renderCanvas();
    await act(async () => {
      flow.props.onConnect({ source: EX + "Document", target: EX + "Invoice", sourceHandle: null, targetHandle: null });
      flow.props.onConnectEnd({ clientX: 40, clientY: 50 });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Every Document has at least one… (a rule)" }));
    });
    expect(onSelect).toHaveBeenCalledWith(EX + "Document");
    expect(projectStore.getSnapshot().ruleDraft).toMatchObject({ cls: EX + "Document", filler: EX + "Invoice" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
  });
});
