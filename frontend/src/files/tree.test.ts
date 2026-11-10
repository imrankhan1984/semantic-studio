/*
================================================================================
FILE: frontend/src/files/tree.test.ts
================================================================================

SUMMARY
    The Files panel's tree as data (multi-file-projects 5.5, Section 6):
    folders first then files at each level, by name without case; a
    collapsed folder hides its rows; each row's words; Remove refused for the
    last ontology file and a folder that is not empty; New file at 100; the
    folder index's sentences.

BASIC IDEA
    Pure functions, so plain inputs and exact outputs.

INPUTS / INPUT SOURCES
    - Inline document states and folder lists.

EXPECTED OUTPUT
    - Pass/fail per assertion.
================================================================================
*/

import { describe, expect, it } from "vitest";
import {
  fileLabel,
  fileRows,
  folderLabel,
  folderRemoveRefusal,
  newFileRefusal,
  noticeLines,
  removeQuestion,
  removeRefusal,
  type FileRowData,
  type FolderRowData,
} from "./tree";

const DOCS = [
  { doc: "model", file: "model.ttl", role: "ontology" as const, dirty: false },
  { doc: "shapes", file: "shapes.ttl", role: "shapes" as const, dirty: false },
  { doc: "f00000001", file: "vocab/equipment.ttl", role: "vocabulary" as const, dirty: true },
  { doc: "f00000002", file: "vocab/Alarms.ttl", role: "ontology" as const, dirty: false },
  { doc: "f00000003", file: "Core.ttl", role: "ontology" as const, dirty: false },
];

describe("the Files tree (5.5 item 2)", () => {
  it("puts folders first, then files, each by name without case", () => {
    const rows = fileRows(DOCS, ["vocab", "spare"], new Set(["vocab"]));
    expect(rows.map((r) => r.path)).toEqual([
      "spare", "vocab", "vocab/Alarms.ttl", "vocab/equipment.ttl", "Core.ttl", "model.ttl", "shapes.ttl",
    ]);
    expect(rows.map((r) => r.level)).toEqual([1, 1, 2, 2, 1, 1, 1]);
  });

  it("hides a collapsed folder's rows and keeps an empty folder's row", () => {
    const rows = fileRows(DOCS, ["vocab", "spare"], new Set());
    expect(rows.map((r) => r.path)).toEqual(["spare", "vocab", "Core.ttl", "model.ttl", "shapes.ttl"]);
    const spare = rows[0] as FolderRowData;
    expect(spare.empty).toBe(true);
    expect(folderLabel(spare)).toBe("spare, folder, empty, collapsed");
  });

  it("knows a folder from its files alone, before it is listed", () => {
    const rows = fileRows(DOCS, [], new Set(["vocab"]));
    expect(rows[0]).toMatchObject({ kind: "folder", path: "vocab", files: 2 });
  });

  it("reads each row's name, role, unsaved state and folder in words (Section 6)", () => {
    const rows = fileRows(DOCS, ["vocab"], new Set(["vocab"]));
    const equipment = rows.find((r) => r.path === "vocab/equipment.ttl") as FileRowData;
    expect(fileLabel(equipment)).toBe("equipment.ttl, vocabulary file, unsaved, in vocab");
    expect(fileLabel(rows.find((r) => r.path === "model.ttl") as FileRowData)).toBe("model.ttl, ontology file");
    expect(folderLabel(rows[0] as FolderRowData)).toBe("vocab, folder, 2 files, expanded");
  });

  it("reads a file a server before E-16 named only by its id", () => {
    const rows = fileRows([{ doc: "model", dirty: false }, { doc: "shapes", dirty: false }], [], new Set());
    expect(rows.map((r) => [r.path, (r as FileRowData).role])).toEqual([
      ["model.ttl", "ontology"], ["shapes.ttl", "shapes"],
    ]);
  });
});

describe("what may be done with a row (Section 6, Disabled)", () => {
  it("refuses Remove on the last ontology or vocabulary file only", () => {
    const one = [DOCS[0], DOCS[1]];
    const rows = fileRows(one, [], new Set()) as FileRowData[];
    expect(removeRefusal(rows[0], one)).toBe(
      "model.ttl is the project's last ontology or vocabulary file, so it cannot be removed.",
    );
    expect(removeRefusal(rows[1], one)).toBeNull();
    const many = fileRows(DOCS, [], new Set()) as FileRowData[];
    expect(removeRefusal(many.find((r) => r.path === "model.ttl") as FileRowData, DOCS)).toBeNull();
  });

  it("refuses Remove on a folder with anything in it", () => {
    const rows = fileRows(DOCS, ["vocab", "spare"], new Set());
    expect(folderRemoveRefusal(rows[1] as FolderRowData)).toBe("Only an empty folder can be removed.");
    expect(folderRemoveRefusal(rows[0] as FolderRowData)).toBeNull();
  });

  it("refuses New file at 100 files", () => {
    expect(newFileRefusal(99)).toBeNull();
    expect(newFileRefusal(100)).toBe("This project has 100 files, the most it can hold.");
  });

  it("asks Remove's question with the count and unsaved changes", () => {
    expect(removeQuestion(42, false)).toBe("It moves to the project's trash; its 42 statements leave the project's views.");
    expect(removeQuestion(1, true)).toBe(
      "It moves to the project's trash; its 1 statement leaves the project's views. Its unsaved changes go with it.",
    );
  });
});

describe("the folder index's sentences (5.2)", () => {
  it("says each once", () => {
    expect(noticeLines({
      found: ["a.ttl", "b.ttl"],
      missing: ["core.ttl"],
      skipped: [{ path: "linked.ttl", reason: "linked.ttl is a link, so it was not read." }],
      wroteModel: true,
    })).toEqual([
      "Found 2 files that were added outside Semantic Studio.",
      "core.ttl is no longer in the project folder.",
      "linked.ttl is a link, so it was not read.",
      "No ontology or vocabulary file was left, so an empty model.ttl was written.",
    ]);
    expect(noticeLines({ found: ["a.ttl"], missing: [], skipped: [], wroteModel: false })).toEqual([
      "Found 1 file that was added outside Semantic Studio.",
    ]);
  });
});
