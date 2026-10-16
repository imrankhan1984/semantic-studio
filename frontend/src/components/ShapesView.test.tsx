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

const { openProject, runCommand, getShapes, getShapeSuggestions, validateProject, searchNodes } = vi.hoisted(() => ({
  openProject: vi.fn(),
  runCommand: vi.fn(),
  getShapes: vi.fn(),
  getShapeSuggestions: vi.fn(),
  validateProject: vi.fn(),
  searchNodes: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  openProject,
  runCommand,
  getShapes,
  getShapeSuggestions,
  validateProject,
  searchNodes,
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

// The first shape opens on arrival (load-and-shapes 5.3), so a test's own
// suggestions must be in place before the view is drawn.
async function setup(
  shapes: ShapeForm[],
  kind: ProjectKind = "ontology",
  documents = [doc("model"), doc("shapes")],
  suggestions: unknown = SUGGESTIONS,
) {
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
  getShapeSuggestions.mockResolvedValue(suggestions);
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

  // axioms-and-reasoning AC-12: Check it in data too writes a qualified
  // count, which the form reads only as the language rule. The shape is
  // then the server's read-only one, and the form offers nothing that could
  // rewrite or drop the rule.
  it("never offers to rewrite a shape that holds a rule checked from the model", async () => {
    const checked: ShapeForm = {
      ...PERSON,
      id: `${X}OrderRules`, iri: `${X}OrderRules`, name: "Order rules",
      editable: false, unsupported: ["uses sh:qualifiedValueShape"],
    };
    await setup([checked]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Order rules/ }));
    });
    expect(screen.getByText("uses sh:qualifiedValueShape")).toBeTruthy();
    for (const name of [/^Edit the rule/, /^Remove the rule/, "+ Add a rule"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByLabelText("A warning")).toBeNull();
    expect(runCommand).not.toHaveBeenCalled();
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

describe("ShapesView: Stage A follow-ups fixed in Stage B (5.9)", () => {
  async function openPerson(shapes: ShapeForm[] = [PERSON]) {
    await setup(shapes);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Person rules/ }));
    });
  }

  /** The timer a focus move is scheduled on, run. */
  async function settle() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  const BIRTH = { path: [`${X}birthDate`], pathLabel: "birth date", pathKind: "attribute" as const, maxCount: 1 };

  it("returns focus to a rule's Edit after Cancel (item 6, row S19)", async () => {
    await openPerson();
    fireEvent.click(screen.getByRole("button", { name: "Edit the rule on name" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit the rule on name" }));
  });

  it("gives focus to the next rule after Remove (item 6)", async () => {
    await openPerson([{ ...PERSON, rules: [BIRTH, ...PERSON.rules] }]);
    runCommand.mockResolvedValue(changed("Removed the rule on birth date"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove the rule on birth date" }));
    });
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit the rule on name" }));
  });

  it("sends focus to + Add a rule when the only rule goes", async () => {
    await openPerson();
    runCommand.mockResolvedValue(changed("Removed the rule on name"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove the rule on name" }));
    });
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "+ Add a rule" }));
  });

  it("leaves announcing to the project's live region: the sentence has none of its own (item 7)", async () => {
    await openPerson();
    const sentence = screen.getByText("Every Person must have a name.");
    expect(sentence.closest("[aria-live]")).toBeNull();
  });

  it("names a rule without a label by its path, never undefined (item 5)", async () => {
    await openPerson([{ ...PERSON, rules: [{ path: [`${X}nickname`], pathKind: "other", minCount: 1 }] }]);
    expect(screen.getByRole("button", { name: "Edit the rule on nickname" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /undefined/ })).toBeNull();
  });

  it("enters a date-and-time range in a date-and-time field, seconds added (item 1)", async () => {
    await setup([PERSON], undefined, undefined, {
      paths: [{ path: [`${X}startsAt`], label: "starts at", kind: "attribute", datatype: "xsd:dateTime", functional: false }],
      suggestions: [],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Person rules/ }));
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Add a rule" }));
    fireEvent.change(screen.getByLabelText("What is the rule about?"), { target: { value: `${X}startsAt` } });
    expect(screen.getByText("Date and time range")).toBeTruthy();
    const low = screen.getByLabelText("at least", { selector: "input" }) as HTMLInputElement;
    expect(low.type).toBe("datetime-local");
    fireEvent.change(low, { target: { value: "2020-01-01T10:00" } });
    runCommand.mockResolvedValue(changed("Added a rule on starts at"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    });
    expect(runCommand.mock.calls[0][3].rule.minInclusive).toEqual({ value: "2020-01-01T10:00:00", datatype: "xsd:dateTime" });
  });

  it("offers a class picker for points to, and one when the relationship has no end class (item 2)", async () => {
    await setup([PERSON], undefined, undefined, {
      paths: [
        ...SUGGESTIONS.paths,
        { path: [`${X}knows`], label: "knows", kind: "relationship", range: null, rangeLabel: null, functional: false },
      ],
      suggestions: [],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Person rules/ }));
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Add a rule" }));
    fireEvent.change(screen.getByLabelText("What is the rule about?"), { target: { value: `${X}knows` } });
    expect(screen.getByText(/Not checked: this relationship has no end class/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Choose a class" }));
    searchNodes.mockResolvedValue([{ id: `${X}Person`, label: "Person", kind: "class", degree: 1 }]);
    const field = screen.getByRole("combobox", { name: "Each value must be of the class" });
    await act(async () => {
      fireEvent.change(field, { target: { value: "Per" } });
      await new Promise((r) => setTimeout(r, 250));
    });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "Enter" });
    await settle();
    expect(screen.getByText("Each value must be a Person")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change class" }));
    runCommand.mockResolvedValue(changed("Added a rule on knows"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    });
    expect(runCommand.mock.calls[0][3].rule).toMatchObject({ path: [`${X}knows`], class: `${X}Person`, classLabel: "Person" });
  });

  it("lets the class follow the path when an existing rule moves to another relationship (found in review)", async () => {
    const worksFor = { path: [`${X}worksFor`], pathLabel: "works for", pathKind: "relationship" as const, class: `${X}Organization`, classLabel: "Organization" };
    await setup([{ ...PERSON, rules: [worksFor] }], undefined, undefined, {
      paths: [
        ...SUGGESTIONS.paths,
        { path: [`${X}knows`], label: "knows", kind: "relationship", range: `${X}Person`, rangeLabel: "Person", functional: false },
      ],
      suggestions: [],
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Person rules/ }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit the rule on works for" }));
    fireEvent.change(screen.getByLabelText("What is the rule about?"), { target: { value: `${X}knows` } });
    expect(screen.getByText("Each value must be a Person")).toBeTruthy();
    // Back on its own path, the rule's own class again.
    fireEvent.change(screen.getByLabelText("What is the rule about?"), { target: { value: `${X}worksFor` } });
    expect(screen.getByText("Each value must be an Organization")).toBeTruthy();
  });

  it("keeps a blank-node shape selected when a Turtle apply gives it a new id (item 8)", async () => {
    const blank: ShapeForm = { ...PERSON, id: "_:b1", iri: null, name: "Unnamed shape", named: false };
    await setup([blank]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Unnamed shape/ }));
    });
    expect(screen.getByRole("heading", { name: "Unnamed shape" })).toBeTruthy();
    // The editor's apply re-parses shapes.ttl: the same shape, a new _: id.
    getShapes.mockResolvedValue(listing([{ ...blank, id: "_:b7" }]));
    await act(async () => {
      projectStore.applied({ revision: 3, label: "Applied the Turtle", state: doc("shapes", 3) } as never);
    });
    await settle();
    expect(screen.getByRole("heading", { name: "Unnamed shape" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Unnamed shape/ }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("ShapesView in two columns (load-and-shapes 5.3, AC-4)", () => {
  const RESULT = (problemCount: number) => ({
    stopped: false, statements: 9, shapeCount: 1, durationMs: 1, revisions: { model: 1, shapes: 1 },
    shapes: [{ id: PERSON.id, name: "Person rules", state: problemCount ? "fails" : "passes", target: null,
      focusCount: 2, failingCount: problemCount ? 1 : 0, problemCount, warningCount: 0, problems: [],
      problemsTotal: problemCount, error: null }],
  });

  it("has the list and one panel with the Shape and Results tabs", async () => {
    await setup([PERSON, CONTACT]);
    const view = document.querySelector(".shapes-view")!;
    expect([...view.children].map((c) => c.className)).toEqual(["shapes-list", "side-panel shapes-panel"]);
    const panel = screen.getByRole("complementary", { name: "Shape and results" });
    const tabs = within(panel).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Shape", "Results"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(within(panel).getByRole("tabpanel")).toBeTruthy();
    expect(document.querySelector(".shapes-results")).toBeNull();
  });

  it("puts Validate at the head of the list, beside +", async () => {
    await setup([PERSON]);
    const head = document.querySelector(".shapes-list-head")!;
    const buttons = within(head as HTMLElement).getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Validate", "Add a shape"]);
    // Validate is the area's one primary button; + beside it is secondary (U-11).
    expect(buttons.map((b) => b.classList.contains("primary"))).toEqual([true, false]);
    // On the Results tab too, the one Validate is the list's.
    fireEvent.click(screen.getByRole("tab", { name: "Results" }));
    expect(screen.getAllByRole("button", { name: "Validate" })).toHaveLength(1);
  });

  it("selects the first shape on arrival without moving focus", async () => {
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();
    await setup([PERSON, CONTACT]);
    expect(screen.getByRole("button", { name: /Person rules/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /Contact rules/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("heading", { name: "Person rules" })).toBeTruthy();
    expect(screen.queryByText("Choose a shape to see its rules.")).toBeNull();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it("shows today's sentence in Shape for a project without shapes", async () => {
    await setup([], "ontology", [doc("model")]);
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("A shape says what good data looks like: every Person has a name, for example.")).toBeTruthy();
  });

  it("does not select again after a delete clears the selection", async () => {
    await setup([PERSON, CONTACT]);
    runCommand.mockResolvedValue(changed("Deleted the shape Person rules"));
    getShapes.mockResolvedValue(listing([CONTACT]));
    fireEvent.click(screen.getByRole("button", { name: "Delete this shape" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("button", { name: /Contact rules/ }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByText("Choose a shape to see its rules.")).toBeTruthy();
  });

  it("shows Results when Validate is pressed: the run's progress, then its panels", async () => {
    await setup([PERSON]);
    let finish!: (value: unknown) => void;
    validateProject.mockReturnValue(new Promise((r) => (finish = r)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    });
    expect(screen.getByRole("tab", { name: "Results" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Checking the model against every shape…")).toBeTruthy();
    await act(async () => {
      finish(RESULT(3));
    });
    expect(screen.queryByText("Checking the model against every shape…")).toBeNull();
    expect(screen.getByRole("button", { name: /Person rules: .*\(3 problems\)/ })).toBeTruthy();
    // Ended on Results: nothing to mark.
    expect(screen.getByRole("tab", { name: "Results" }).textContent).toBe("Results");
  });

  it("marks Results with the problems found, in words, when a run ends on Shape", async () => {
    await setup([PERSON]);
    let finish!: (value: unknown) => void;
    validateProject.mockReturnValue(new Promise((r) => (finish = r)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    });
    fireEvent.click(screen.getByRole("tab", { name: "Shape" }));
    await act(async () => {
      finish(RESULT(3));
    });
    const results = screen.getByRole("tab", { name: "Results, 3 problems" });
    expect(results.textContent).toBe("Results · 3 problems");
    expect(results.getAttribute("aria-selected")).toBe("false");
    // Seen once: choosing the tab clears it.
    fireEvent.click(results);
    expect(screen.getByRole("tab", { name: "Results" }).textContent).toBe("Results");
  });

  it("marks nothing when a run fails and leaves the old result", async () => {
    await setup([PERSON]);
    validateProject.mockResolvedValueOnce(RESULT(1));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    });
    let fail!: (e: Error) => void;
    validateProject.mockReturnValue(new Promise((_, reject) => (fail = reject)));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    });
    fireEvent.click(screen.getByRole("tab", { name: "Shape" }));
    await act(async () => {
      fail(new Error("The server is not answering."));
    });
    expect(screen.getByRole("tab", { name: "Results" }).textContent).toBe("Results");
  });

  it("arrives at Results while a run is going, and marks nothing for a result that was there before", async () => {
    // The data wizard's Validate starts a run as it opens Shapes.
    openProject.mockResolvedValue({
      project: { id: PID, name: "Shop", createdAt: "", updatedAt: "", baseIri: X, prefix: "x", primaryLanguage: "en",
        languages: [], documents: [], counts: {}, kind: "ontology" },
      documents: [doc("model"), doc("shapes")],
      recovery: { available: false, draftTime: null },
    });
    await projectStore.open(PID);
    getShapes.mockResolvedValue(listing([PERSON]));
    getShapeSuggestions.mockResolvedValue(SUGGESTIONS);
    let finish!: (value: unknown) => void;
    validateProject.mockReturnValue(new Promise((r) => (finish = r)));
    let running!: Promise<unknown>;
    await act(async () => {
      running = projectStore.validate();
    });
    await act(async () => {
      render(<ShapesView projectId={PID} kind="ontology" languages={["en"]} modelOntologyId={`${PID}-model`}
        onSelectEntity={vi.fn()} onEditInTurtle={vi.fn()} onError={vi.fn()} />);
    });
    expect(screen.getByRole("tab", { name: "Results" }).getAttribute("aria-selected")).toBe("true");
    await act(async () => {
      finish(RESULT(2));
      await running;
    });
    cleanup();
    // Back later, with that result in the store: Shape, unmarked.
    await act(async () => {
      render(<ShapesView projectId={PID} kind="ontology" languages={["en"]} modelOntologyId={`${PID}-model`}
        onSelectEntity={vi.fn()} onEditInTurtle={vi.fn()} onError={vi.fn()} />);
    });
    expect(screen.getByRole("tab", { name: "Shape" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Results" }).textContent).toBe("Results");
  });

  it("shows Shape again when a shape is chosen in the list while Results shows (found in review)", async () => {
    await setup([PERSON, CONTACT]);
    fireEvent.click(screen.getByRole("tab", { name: "Results" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Contact rules/ }));
    });
    expect(screen.getByRole("tab", { name: "Shape" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("heading", { name: "Contact rules" })).toBeTruthy();
  });

  it("shows Shape for a shape made with + while Results shows, and focus reaches its form (found in review)", async () => {
    await setup([PERSON]);
    fireEvent.click(screen.getByRole("tab", { name: "Results" }));
    runCommand.mockResolvedValue(changed("Made the shape Model check", CONTACT.id));
    getShapes.mockResolvedValue(listing([PERSON, CONTACT]));
    fireEvent.click(screen.getByRole("button", { name: "Add a shape" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Check my model" }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByRole("tab", { name: "Shape" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.id).toBe("shape-form-heading");
  });

  it("keeps a rule being edited through Validate and back (found in review)", async () => {
    await setup([PERSON]);
    fireEvent.click(screen.getByRole("button", { name: "+ Add a rule" }));
    fireEvent.change(screen.getByLabelText("What is the rule about?"), { target: { value: `${X}birthDate` } });
    validateProject.mockResolvedValue(RESULT(0));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    });
    expect(screen.getByRole("tab", { name: "Results" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Shape" }));
    expect((screen.getByLabelText("What is the rule about?") as HTMLInputElement).value).toBe(`${X}birthDate`);
  });

  it("moves between the tabs with the arrow keys, the selected one in the tab order", async () => {
    await setup([PERSON]);
    const shape = screen.getByRole("tab", { name: "Shape" });
    shape.focus();
    fireEvent.keyDown(shape, { key: "ArrowRight" });
    const results = screen.getByRole("tab", { name: "Results" });
    expect(document.activeElement).toBe(results);
    expect(results.getAttribute("aria-selected")).toBe("true");
    expect(results.tabIndex).toBe(0);
    expect(shape.tabIndex).toBe(-1);
  });
});
