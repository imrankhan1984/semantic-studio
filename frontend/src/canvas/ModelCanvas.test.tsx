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
import type { CanvasView } from "../types";

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
    total: 4,
    limited: false,
    layout: { version: 1, positions: { [EX + "Document"]: [0, 0] }, shown: null, viewport: null },
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
      { kind: "subClassOf", source: EX + "Invoice", target: EX + "Document" },
      { kind: "broader", source: EX + "Paid", target: EX + "Status" },
      { kind: "relationship", source: EX + "Invoice", target: "http://xmlns.com/foaf/0.1/Agent", property: EX + "billedTo", label: "billed to" },
    ],
    undrawn: [
      { iri: EX + "mentions", label: "mentions", kind: "objectProperty", missing: "range", domain: EX + "Invoice", range: null },
    ],
    ...changes,
  };
}

const onSelect = vi.fn();
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
  for (const mock of [openProject, closeProject, runCommand, getCanvas, putLayout, previewDelete, getNodeDetails, onSelect, onDeleted, onCanvasSet]) {
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
  putLayout.mockImplementation(async (_p, _d, layout) => layout);
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
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["is a kind of", "new relationship…"]);
    await act(async () => {
      fireEvent.click(within(menu).getByRole("menuitem", { name: "is a kind of" }));
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
      fireEvent.click(screen.getByRole("menuitem", { name: "mentions" }));
    });
    expect(lastCommand()).toEqual(["SetRange", { property: EX + "mentions", target: EX + "Document" }]);
  });

  it("concept to concept: narrower than runs AddBroader", async () => {
    await renderCanvas();
    await draw(EX + "Status", EX + "Paid");
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "narrower than" }));
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
      fireEvent.click(screen.getByRole("menuitem", { name: "is a kind of" }));
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
    const { rerender } = await renderCanvas(viewOf({ layout: { version: 1, positions: placed, shown: null, viewport: null } }));
    const renamed = viewOf({
      revision: 3,
      nodes: viewOf().nodes.map((n) => (n.iri === EX + "Invoice" ? { ...n, iri: EX + "Bill", label: "Bill" } : n)),
      edges: [],
      layout: {
        version: 1,
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
      viewOf({ limited: true, nodes: [], edges: [], layout: { version: 1, positions: {}, shown: [], viewport: null } }),
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
    await renderCanvas(viewOf({ limited: true, nodes: [], edges: [], layout: { version: 1, positions: {}, shown: [], viewport: null } }));
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
