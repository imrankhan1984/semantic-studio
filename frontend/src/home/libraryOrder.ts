/*
================================================================================
FILE: frontend/src/home/libraryOrder.ts
================================================================================

SUMMARY
    The order of Home's one library (home-and-examples 5.5): the person's
    projects and loaded files first, most recent first, then the three
    bundled examples in their fixed order.

BASIC IDEA
    A project is dated by its last change (`updatedAt`), a file by when it
    was added (`addedAt`), and the two are compared as one list, because to
    the person they are one body of work. An entry with no date (a file
    stored before `addedAt` was kept) sorts after the dated ones rather than
    before them. Examples never mix in: they follow everything the person
    made, however old that is, in EXAMPLE_ORDER -- the manifest's order on
    the server, which a test holds the two to.

    An example is told by `source === "example"` and the `example` record the
    server keeps with it, never by its name: a person's own file may well be
    called FOAF.

INPUTS / INPUT SOURCES
    - The project list and the ontology list App fetched on mount.

EXPECTED OUTPUT
    - libraryEntries(projects, ontologies): the entries in display order.
    - isExample(summary), missingExamples(ontologies), EXAMPLE_ORDER.
================================================================================
*/

import type { OntologySummary, ProjectSummary } from "../types";

/** The examples' keys in their order on Home: backend/app/examples/manifest.json's. */
export const EXAMPLE_ORDER = ["space", "middle-earth", "foaf"] as const;

export type LibraryEntry =
  | { kind: "project"; id: string; name: string; project: ProjectSummary }
  | { kind: "ontology"; id: string; name: string; ontology: OntologySummary };

export function isExample(summary: OntologySummary): boolean {
  return summary.source === "example" && !!summary.example;
}

/** The example keys not in the library, in their order. */
export function missingExamples(ontologies: OntologySummary[]): string[] {
  const present = new Set(ontologies.filter(isExample).map((o) => o.example!.key));
  return EXAMPLE_ORDER.filter((key) => !present.has(key));
}

function time(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

function exampleRank(summary: OntologySummary): number {
  const rank = (EXAMPLE_ORDER as readonly string[]).indexOf(summary.example?.key ?? "");
  return rank === -1 ? EXAMPLE_ORDER.length : rank;
}

export function libraryEntries(
  projects: ProjectSummary[],
  ontologies: OntologySummary[],
): LibraryEntry[] {
  const own: { entry: LibraryEntry; at: number }[] = [
    ...projects.map((project) => ({
      entry: { kind: "project" as const, id: project.id, name: project.name, project },
      at: time(project.updatedAt),
    })),
    ...ontologies
      .filter((o) => !isExample(o))
      .map((ontology) => ({
        entry: { kind: "ontology" as const, id: ontology.id, name: ontology.name, ontology },
        at: time(ontology.addedAt),
      })),
  ];
  // Array.prototype.sort is stable, so two entries dated alike keep the
  // order their lists gave them.
  own.sort((a, b) => b.at - a.at);
  const examples = ontologies
    .filter(isExample)
    .sort((a, b) => exampleRank(a) - exampleRank(b))
    .map((ontology): LibraryEntry => ({ kind: "ontology", id: ontology.id, name: ontology.name, ontology }));
  return [...own.map((o) => o.entry), ...examples];
}
