/*
================================================================================
FILE: frontend/src/statusWords.ts
================================================================================

SUMMARY
    The status bar's words (portal-foundations 5.6): on Home, what is there
    (*2 projects · 1 ontology in the library*); elsewhere, a file's format
    named as people write it (*Turtle*, not *turtle*).

BASIC IDEA
    Kept out of App so the singular, the plural and the zero case are tested
    without rendering, the same split as networkWords.ts. A zero part is left
    out rather than written as *0 projects*; with nothing at all the bar says
    how to begin. A format the table does not know is shown as it comes, and
    the lookup is own-key, as every lookup of a server's string is (X-6).

INPUTS / INPUT SOURCES
    - The number of projects and of library ontologies, from App's lists.
    - An ontology's `format`, the rdflib parser name the server reports.

EXPECTED OUTPUT
    - homeStatus(projects, ontologies): the Home line.
    - formatName(format): the format's written name.
================================================================================
*/

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function homeStatus(projects: number, ontologies: number): string {
  const parts: string[] = [];
  if (projects > 0) parts.push(plural(projects, "project", "projects"));
  if (ontologies > 0) parts.push(`${plural(ontologies, "ontology", "ontologies")} in the library`);
  return parts.length ? parts.join(" · ") : "Load an ontology or start a project to begin.";
}

/** The parser names store.py's EXTENSION_FORMATS and SNIFF_ORDER use. */
const FORMAT_NAMES: Record<string, string> = {
  turtle: "Turtle",
  xml: "RDF/XML",
  "json-ld": "JSON-LD",
  nt: "N-Triples",
  n3: "N3",
  trig: "TriG",
  nquads: "N-Quads",
};

export function formatName(format: string): string {
  return Object.prototype.hasOwnProperty.call(FORMAT_NAMES, format) ? FORMAT_NAMES[format] : format;
}
