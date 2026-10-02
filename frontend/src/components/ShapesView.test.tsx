// @vitest-environment jsdom
/*
================================================================================
FILE: frontend/src/components/ShapesView.test.tsx
================================================================================

SUMMARY
    The Shapes view (shacl-authoring 5.1 to 5.5, AC-1 to AC-4): the empty
    list's sentence; + and its chooser by project kind; a new shape opening
    in the form and selected in the list; the shape's sentence; a rule added
    through the rule editor, Add kept disabled with a sentence until it can
    be added; Edit and Remove on a rule; a suggestion added as one merge;
    severity, name and delete; a Turtle shape read-only with Edit in Turtle;
    and each row's last result as a word.

BASIC IDEA
    api.ts is mocked and the real project store is opened on a fixed
    project, so every control goes through the commands the server would
    receive; each test asserts the command and its arguments.

INPUTS / INPUT SOURCES
    - A mocked api.ts.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openProject, runCommand, getShapes, getShapeSuggestions, validateProject } = vi.hoisted(() => ({
  openProject: vi.fn(),
  runCommand: vi.fn(),
  getShapes: vi.fn(),
  getShapeSuggestions: vi.fn(),
  validateProject: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  runCommand,
  getShapes,
  getShapeSuggestions,
  validateProject,
}));

import { projectStore } from "../state/projectStore";
import type { ProjectKind, ShapeForm, ShapesListing } from "../types";
import ShapesView from "./ShapesView";

const PID = "prj-0123456789ab";
const X = "http://x#";

function doc(name: "model" | "shapes", revision = 1) {
  return {
    doc: name, ontologyId: `${PID}-${name}`, revision, dirty: false,
    canUndo: false, undoLabel: null, canRedo: false, redoLabel: null, triples: 1,
  };
}

const PERSON: ShapeForm = {
  id: `${X}PersonRules`, iri: `${X}PersonRules`, name: "Person rules", named: true,
  target: { iri: `${X}Person`, label: "Person", every: null }, severity: "violation", message: null,
  rules: [{ path: [`${X}name`], pathLabel: "name", pathKind: "attribute", minCount: 1 }],
  editable: true, unsupported: [],
};

const CONTACT: ShapeForm = {
  id: `${X}ContactShape`, iri: `${X}ContactShape`, name: "Contact rules", named: true,
  target: { iri: `${X}Person`, label: "Person", every: null }, severity: "violation", message: null,
  rules: [], editable: false, unsupported: ["uses sh:or"],
};

const SUGGESTIONS = {
  paths: [
    { path: ["http://www.w3.org/2000/01/rdf-schema#label"], label: "name", kind: "name" },
    { path: [`${X}birthDate`], label: "birth date", kind: "attribute", datatype: "xsd:date", functional: true },
    { path: [`${X}name`], label: "name", kind: "attribute", datatype: "xsd:string", functional: false },
    { path: [`${X}worksFor`], label: "works for", kind: "relationship", range: `${X}Organization`, rangeLabel: "Organization", functional: false },
  ],
  suggestions: [
    { id: `type:${X}birthDate`, rule: { path: [`${X}birthDate`], datatype: "xsd:date", pathLabel: "birth date", pathKind: "attribute" } },
  ],
};

function listing(shapes: ShapeForm[], kind: ProjectKind = "ontology"): ShapesListing {
  return { revision: 1, modelRevision: 1, kind, shapes };
}

let props: {
  onSelectEntity: ReturnType<typeof vi.fn<(iri: string) => void>>;
  onEditInTurtle: ReturnType<typeof vi.fn<(shape: ShapeForm) => void>>;
  onError: ReturnType<typeof vi.fn<(message: string) => void>>;
};

async function setup(shapes: ShapeForm[], kind: ProjectKind = "ontology", documents = [doc("model"), doc("shapes")]) {
  openProject.mockResolvedValue({
    project: {
      id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: X, prefix: "x", primaryLanguage: "en",
      languages: ["fr"], documents: [], counts: {}, kind,
    },
    documents,
    recovery: { available: false, draftTime: null },
  });
  await projectStore.open(PID);
  getShapes.mockResolvedValue(listing(shapes, kind));
  getShapeSuggestions.mockResolvedValue(SUGGESTIONS);
  props = {
    onSelectEntity: vi.fn<(iri: string) => void>(),
    onEditInTurtle: vi.fn<(shape: ShapeForm) => void>(),
    onError: vi.fn<(message: string) => void>(),
  };
  await act(async () => {
    render(
      <ShapesView projectId={PID} kind={kind} languages={["en", "fr"]} modelOntologyId={`${PID}-model`} {...props} />,
    );
  });
}

function changed(label: string, created?: string) {
  return { revision: 2, label, state: doc("shapes", 2), ...(created ? { created } : {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  projectStore._reset();
});
afterEach(cleanup);

describe("ShapesView: the list and +", () => {
  it("says what to do when there are no shapes yet", async () => {
    await setup([], "ontology", [doc("model")]);
    expect(screen.getByText("No shapes yet. Press + to add rules for a class, or check your model.")).toBeTruthy();
  });

  it("offers rules for a class and the model check in an ontology", async () => {
    await setup([]);
    const plus = screen.getByRole("button", { name: "Add a shape" });
    fireEvent.click(plus);
    expect(plus.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "Rules for a class" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check my model" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rules for concepts" })).toBeNull();
  });

  it("offers rules for concepts in a taxonomy, made without a class to pick", async () => {
    await setup([], "taxonomy");
    fireEvent.click(screen.getByRole("button", { name: "Add a shape" }));
    runCommand.mockResolvedValue(changed("Created shape Concept rules", `${X}ConceptRules`));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Rules for concepts" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "shapes", "CreateShape", {
      target: "http://www.w3.org/2004/02/skos/core#Concept",
    });
  });

  it("makes shapes.ttl with the first +, tracks it, and opens the new shape alone", async () => {
    await setup([], "ontology", [doc("model")]);
    runCommand.mockResolvedValue(changed("Created shape Check my model", `${X}CheckMyModel`));
    const check: ShapeForm = {
      ...PERSON, id: `${X}CheckMyModel`, iri: `${X}CheckMyModel`, name: "Check my model",
      target: { iri: "http://www.w3.org/2002/07/owl#Class", label: "Class", every: "every class" },
    };
    openProject.mockResolvedValue({
      project: (await openProject.mock.results[0].value).project,
      documents: [doc("model"), doc("shapes", 2)],
      recovery: { available: false, draftTime: null },
    });
    getShapes.mockResolvedValue(listing([check]));
    fireEvent.click(screen.getByRole("button", { name: "Add a shape" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check my model" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "shapes", "CreateShape", { preset: "modelCheck" });
    expect(projectStore.getSnapshot().documents.map((d) => d.doc)).toEqual(["model", "shapes"]);
    expect(screen.getByRole("heading", { level: 3, name: "Check my model" })).toBeTruthy();
    // Focus goes to the new form once it is drawn (found in the Chrome pass:
    // it fell to the page when the list arrived after the command).
    expect(document.activeElement).toBe(screen.getByRole("heading", { level: 3, name: "Check my model" }));
    expect(screen.getByRole("button", { name: /Check my model/, pressed: true })).toBeTruthy();
    expect(screen.getByText("Every class must have a name.")).toBeTruthy();
  });

  it("keeps a new shape selected while the list that holds it is still on its way", async () => {
    // Found in the Chrome pass: the old list arrived first and dropped the
    // selection of the shape just made.
    await setup([PERSON]);
    const made: ShapeForm = { ...PERSON, id: `${X}OrganizationRules`, iri: `${X}OrganizationRules`, name: "Organization rules",
      target: { iri: `${X}Organization`, label: "Organization", every: null }, rules: [] };
    let deliver!: (l: ShapesListing) => void;
    getShapes.mockReturnValue(new Promise((resolve) => (deliver = resolve)));
    runCommand.mockResolvedValue(changed("Created shape Check my model", made.id));
    fireEvent.click(screen.getByRole("button", { name: "Add a shape" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check my model" }));
    });
    await act(async () => deliver({ ...listing([PERSON, made]), revision: 2 }));
    expect(screen.getByRole("heading", { level: 3, name: "Organization rules" })).toBeTruthy();
  });

  it("shows each row's sentence and its last result as a word", async () => {
    await setup([PERSON, CONTACT]);
    const row = screen.getByRole("button", { name: /Person rules/ });
    expect(row.textContent).toContain("Every Person: 1 rule");
    expect(row.textContent).toContain("Not checked");
    validateProject.mockResolvedValue({
      stopped: false, statements: 9, shapeCount: 2, durationMs: 1, revisions: { model: 1, shapes: 1 },
      shapes: [{ id: PERSON.id, name: "Person rules", state: "fails", target: null, focusCount: 2, failingCount: 1,
        problemCount: 1, warningCount: 0, problems: [], problemsTotal: 1, error: null }],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    });
    expect(row.textContent).toContain("Fails");
    expect(screen.getByRole("button", { name: /Contact rules/ }).textContent).toContain("Turtle");
  });
});

describe("ShapesView: the form", () => {
  async function openPerson(shapes: ShapeForm[] = [PERSON]) {
    await setup(shapes);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Person rules/ }));
    });
  }

  it("reads the shape back as a sentence and lists its rules", async () => {
    await openPerson();
    expect(screen.getByText("Every Person must have a name.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit the rule on name" })).toBeTruthy();
  });

  it("adds a rule through the editor, Add disabled with a sentence until it can be added", async () => {
    await openPerson();
    fireEvent.click(screen.getByRole("button", { name: "+ Add a rule" }));
    const add = screen.getByRole("button", { name: "Add rule" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    fireEvent.change(screen.getByLabelText("What is the rule about?"), { target: { value: `${X}birthDate` } });
    // The attribute's type of value is offered first, from the model.
    expect((screen.getByLabelText("Type of value") as HTMLSelectElement).value).toBe("xsd:date");
    fireEvent.change(screen.getByLabelText("How many"), { target: { value: "exactlyOne" } });
    expect(screen.getByText("Reads: must have exactly one birth date, as a date.")).toBeTruthy();
    expect(add.getAttribute("aria-disabled")).toBe("false");
    runCommand.mockResolvedValue(changed("Added a rule on birth date to Person rules"));
    await act(async () => {
      fireEvent.click(add);
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "shapes", "AddRule", {
      shape: PERSON.id,
      rule: { path: [`${X}birthDate`], pathLabel: "birth date", pathKind: "attribute", minCount: 1, maxCount: 1, datatype: "xsd:date" },
    });
  });

  it("keeps Add disabled for an impossible count and says why", async () => {
    await openPerson();
    fireEvent.click(screen.getByRole("button", { name: "+ Add a rule" }));
    fireEvent.change(screen.getByLabelText("What is the rule about?"), { target: { value: `${X}name` } });
    fireEvent.change(screen.getByLabelText("How many"), { target: { value: "between" } });
    fireEvent.change(screen.getByLabelText("from"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("to"), { target: { value: "2" } });
    expect(screen.getByRole("button", { name: "Add rule" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText(/could never be met/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("offers points to for a relationship", async () => {
    await openPerson();
    fireEvent.click(screen.getByRole("button", { name: "+ Add a rule" }));
    fireEvent.change(screen.getByLabelText("What is the rule about?"), { target: { value: `${X}worksFor` } });
    // The relationship's end class by default, with a picker to change it
    // (Stage A follow-up 2), no longer a checkbox.
    expect(screen.getByText("Each value must be an Organization")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change class" })).toBeTruthy();
    expect(screen.getByText("Reads: works for an Organization.")).toBeTruthy();
    expect(screen.queryByLabelText("Type of value")).toBeNull();
  });

  it("edits and removes a rule, each one command", async () => {
    await openPerson();
    fireEvent.click(screen.getByRole("button", { name: "Edit the rule on name" }));
    fireEvent.change(screen.getByLabelText("How many"), { target: { value: "atMostOne" } });
    runCommand.mockResolvedValue(changed("Changed the rule on name of Person rules"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    });
    expect(runCommand).toHaveBeenLastCalledWith(PID, "shapes", "ReplaceRule", {
      shape: PERSON.id, path: [`${X}name`],
      rule: { path: [`${X}name`], pathLabel: "name", pathKind: "attribute", maxCount: 1 },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove the rule on name" }));
    });
    expect(runCommand).toHaveBeenLastCalledWith(PID, "shapes", "RemoveRule", { shape: PERSON.id, path: [`${X}name`] });
  });

  it("adds a suggestion as one merge", async () => {
    await openPerson();
    expect(getShapeSuggestions).toHaveBeenCalledWith(PID, `${X}Person`, PERSON.id);
    runCommand.mockResolvedValue(changed("Added a rule on birth date"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add: may have birth dates, each a date" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "shapes", "AddRule", {
      shape: PERSON.id, rule: SUGGESTIONS.suggestions[0].rule, merge: true,
    });
  });

  it("changes the severity and shows a refusal without ticking what was refused", async () => {
    await openPerson();
    runCommand.mockRejectedValue(new Error("Refused for a reason."));
    await act(async () => {
      fireEvent.click(screen.getByLabelText("A warning"));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "shapes", "SetShapeSeverity", { shape: PERSON.id, severity: "warning" });
    expect(screen.getByText("Refused for a reason.")).toBeTruthy();
    expect((screen.getByLabelText("A problem") as HTMLInputElement).checked).toBe(true);
  });

  it("counts the rules before deleting the shape", async () => {
    await openPerson();
    fireEvent.click(screen.getByRole("button", { name: "Delete this shape" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Its rule goes with it/)).toBeTruthy();
    runCommand.mockResolvedValue(changed("Deleted shape Person rules"));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    expect(runCommand).toHaveBeenCalledWith(PID, "shapes", "DeleteShape", { shape: PERSON.id });
  });

  it("shows a Turtle shape read-only, saying why, with Edit in Turtle", async () => {
    await setup([CONTACT]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Contact rules/ }));
    });
    expect(screen.getByText("uses sh:or")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "+ Add a rule" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit in Turtle" }));
    expect(props.onEditInTurtle).toHaveBeenCalledWith(CONTACT);
  });

  // Found in review: editing a rule must change only what was changed.
  it("keeps a one-sided count one-sided when a rule is edited", async () => {
    await openPerson([{ ...PERSON, rules: [{ path: [`${X}name`], pathLabel: "name", pathKind: "attribute", minCount: 2 }] }]);
    fireEvent.click(screen.getByRole("button", { name: "Edit the rule on name" }));
    expect((screen.getByLabelText("How many") as HTMLSelectElement).value).toBe("atLeast");
    runCommand.mockResolvedValue(changed("Changed the rule"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    });
    expect(runCommand.mock.calls[0][3].rule).toEqual({ path: [`${X}name`], pathLabel: "name", pathKind: "attribute", minCount: 2 });
  });

  it("keeps what the editor does not show for a path, and an untouched list exactly", async () => {
    const label = "http://www.w3.org/2000/01/rdf-schema#label";
    const allowed = [{ kind: "text" as const, value: "active", lang: "en" }, { kind: "typed" as const, value: "a, b", datatype: "xsd:string" }];
    await openPerson([{ ...PERSON, rules: [
      { path: [label], pathLabel: "name", pathKind: "name", minCount: 1, datatype: "rdf:langString", in: allowed },
    ] }]);
    fireEvent.click(screen.getByRole("button", { name: "Edit the rule on name" }));
    fireEvent.change(screen.getByLabelText("How many"), { target: { value: "exactlyOne" } });
    runCommand.mockResolvedValue(changed("Changed the rule"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save rule" }));
    });
    const sent = runCommand.mock.calls[0][3].rule;
    expect(sent.datatype).toBe("rdf:langString");
    expect(sent.in).toEqual(allowed);
    expect([sent.minCount, sent.maxCount]).toEqual([1, 1]);
  });

  it("says a shape without a target has nothing to suggest yet, rather than reading for ever", async () => {
    await setup([{ ...PERSON, target: null }]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Person rules/ }));
    });
    expect(screen.getByText("Choose what the shape applies to, and the model suggests rules for it.")).toBeTruthy();
    expect(screen.queryByText("Reading the model…")).toBeNull();
  });
});
