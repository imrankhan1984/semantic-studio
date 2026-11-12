/*
================================================================================
FILE: frontend/src/projects/folderWords.test.ts
================================================================================

SUMMARY
    The words of projects anywhere, and the subfolder rule held to the table
    the server's test reads too (folderName.table.json).

BASIC IDEA
    Pure functions, so plain assertions; the table is asserted to have loaded
    before anything is said about it.

INPUTS / INPUT SOURCES
    - folderWords.ts, folderName.table.json.

EXPECTED OUTPUT
    - Pass/fail.
================================================================================
*/

import { describe, expect, it } from "vitest";
import table from "./folderName.table.json";
import {
  folderAnnounced,
  folderName,
  foundNotice,
  joinPath,
  missingLine,
  removeQuestion,
  showingSome,
  willBeMadeIn,
} from "./folderWords";

describe("folderName", () => {
  it("reads the shared table", () => {
    expect(table.names.length).toBeGreaterThan(10);
  });

  it.each(table.names as [string, string | null][])("%j makes %j", (name, made) => {
    expect(folderName(name)).toBe(made);
  });
});

describe("the sentences", () => {
  it("joins with the folder's own separator", () => {
    expect(joinPath("D:\\Work", "Motors")).toBe("D:\\Work\\Motors");
    expect(joinPath("/home/ann/work", "Motors")).toBe("/home/ann/work/Motors");
    expect(joinPath("D:\\", "Motors")).toBe("D:\\Motors");
  });

  it("says where New project will make the project", () => {
    expect(willBeMadeIn("D:\\Work", "Motor catalogue")).toBe("The project will be made in D:\\Work\\Motor catalogue.");
    expect(willBeMadeIn("D:\\Work", "CON")).toMatch(/^Give the project a name/);
  });

  it("counts and announces", () => {
    expect(showingSome(1000, 3412)).toBe(
      "Showing 1,000 of 3,412 folders. Type the start of a name to narrow the list.",
    );
    expect(folderAnnounced("D:\\Work", 12)).toBe("D:\\Work, 12 folders");
    expect(folderAnnounced("D:\\Work", 1)).toBe("D:\\Work, 1 folder");
  });

  it("speaks of a moved folder and of removing", () => {
    expect(missingLine("D:\\Work\\Motors")).toBe("Folder not found: D:\\Work\\Motors");
    expect(removeQuestion("Motors", "D:\\Work\\Motors")).toBe(
      "Remove Motors from Home? Its folder D:\\Work\\Motors stays as it is. You can open it again with Open project folder.",
    );
    expect(foundNotice("Motors", "Motors v2")).toBe("Found Motors v2 in that folder.");
    expect(foundNotice("Motors", "Motors")).toBe("Found Motors.");
  });
});
