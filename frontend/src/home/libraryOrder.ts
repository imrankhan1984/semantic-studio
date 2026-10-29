/*
================================================================================
FILE: frontend/src/home/libraryOrder.ts
================================================================================

SUMMARY
    The order of Home's one library (home-and-examples 5.5,
    reference-ontologies 5.2): the person's projects and loaded files first,
    most recent first, then the two bundled examples, then the two bundled
    reference ontologies, each group in its fixed order.

BASIC IDEA
    A project is dated by its last change (`updatedAt`), a file by when it
    was added (`addedAt`), and the two are compared as one list, because to
    the person they are one body of work. An entry with no date (a file
    stored before `addedAt` was kept) sorts after the dated ones rather than
    before them. Bundled entries never mix in: they follow everything the
    person made, however old that is, the examples (teaching material) before
    the reference ontologies (published vocabularies to build on), each in
    BUNDLED's order -- the manifest's on the server, which a test holds the
    two to.

    A bundled entry is told by `source === "example"` and the `example`
    record the server keeps with it, never by its name: a person's own file
    may well be called FOAF. Its group is the record's, which the server
    attaches when it lists the library; BUNDLED's is the fallback for a
    server that predates groups. Code names keep *example* for all four, as
    the server's do.

INPUTS / INPUT SOURCES
    - The project list and the ontology list App fetched on mount.

EXPECTED OUTPUT
    - libraryEntries(projects, ontologies): the entries in display order.
    - isExample(summary), isReference(summary), missingBundled(ontologies),
      BUNDLED.
================================================================================
*/

import type { OntologySummary, ProjectSummary } from "../types";

export type BundledGroup = "example" | "reference";

/** The bundled entries in their order: backend/app/examples/manifest.json's
 *  keys, names and groups. The names are what *Missing:* says of one not in
 *  the library, which has no summary to read a name from. */
export const BUNDLED: readonly { key: string; name: string; group: BundledGroup }[] = [
  { key: "space", name: "Space Exploration", group: "example" },
  { key: "middle-earth", name: "The Lord of the Rings", group: "example" },
  { key: "foaf", name: "FOAF (Friend of a Friend)", group: "reference" },
  { key: "qudt", name: "QUDT", group: "reference" },
];

export type LibraryEntry =
  | { kind: "project"; id: string; name: string; project: ProjectSummary }
  | { kind: "ontology"; id: string; name: string; ontology: OntologySummary };

/** A bundled entry of either group. */
export function isExample(summary: OntologySummary): boolean {
  return summary.source === "example" && !!summary.example;
}

function bundledIndex(key: string | undefined): number {
  return BUNDLED.findIndex((b) => b.key === key);
}

function groupOf(summary: OntologySummary): BundledGroup {
  const told = summary.example?.group;
  if (told === "example" || told === "reference") return told;
  return BUNDLED[bundledIndex(summary.example?.key)]?.group ?? "example";
}

/** A bundled reference ontology (FOAF, QUDT): its card's chip says *Reference*. */
export function isReference(summary: OntologySummary): boolean {
  return isExample(summary) && groupOf(summary) === "reference";
}

/** The bundled entries not in the library, in their order. */
export function missingBundled(ontologies: OntologySummary[]): (typeof BUNDLED)[number][] {
  const present = new Set(ontologies.filter(isExample).map((o) => o.example!.key));
  return BUNDLED.filter((b) => !present.has(b.key));
}

function time(iso: string | undefined): number {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

function bundledRank(summary: OntologySummary): number {
  const index = bundledIndex(summary.example?.key);
  // The group first, then the manifest's order; a key this build does not
  // know goes last in its group.
  return (groupOf(summary) === "reference" ? BUNDLED.length + 1 : 0) + (index === -1 ? BUNDLED.length : index);
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
  const bundled = ontologies
    .filter(isExample)
    .sort((a, b) => bundledRank(a) - bundledRank(b))
    .map((ontology): LibraryEntry => ({ kind: "ontology", id: ontology.id, name: ontology.name, ontology }));
  return [...own.map((o) => o.entry), ...bundled];
}
