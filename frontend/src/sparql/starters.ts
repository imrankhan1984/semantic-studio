/*
================================================================================
FILE: frontend/src/sparql/starters.ts
================================================================================

SUMMARY
    Builds "suggested starting points": ready-made queries and entry-point
    classes derived from the loaded ontology's own schema, shown on the empty
    query panel.

BASIC IDEA
    A newcomer facing an empty builder has no idea what the data can answer.
    These give concrete, one-click queries that already work against the loaded
    ontology and stay editable afterwards — learning by example rather than by
    guessing at the graph. Suggestions are derived from the richest parts of
    the schema (most-populated classes, real relationships, SKOS hierarchy).

INPUTS / INPUT SOURCES
    - The QuerySchema returned by the backend (classes, links, instance counts).

EXPECTED OUTPUT
    - buildStarters -> a short list of Starter objects (title, detail, ready
      QueryState) for the "Try one of these" section.
    - entryPoints -> the classes worth offering in "Or start from".
================================================================================
*/

import type { QuerySchema, SchemaClass, SchemaLink } from "../types";
import { plural } from "./describe";
import { emptyQueryState } from "./types";
import type { QueryState } from "./types";

// SKOS namespace, used to build the taxonomy-specific starters and to skip SKOS
// classes in the generic relationship starters.
const SKOS = "http://www.w3.org/2004/02/skos/core#";

/** "Concept" -> "Concepts", capitalised for use in a starter title. */
function pluralTitle(label: string): string {
  const word = plural(label);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** One suggested query: a label, a one-line detail, and a ready-to-run state. */
export interface Starter {
  id: string;
  title: string;
  detail: string;
  state: QueryState;
}

/** Look up a schema class by IRI. */
function classOf(schema: QuerySchema, iri: string): SchemaClass | undefined {
  return schema.classes.find((c) => c.iri === iri);
}

/** A one-step query over a single class (optionally with extra state, e.g. count). */
function singleStep(cls: SchemaClass, extra: Partial<QueryState> = {}): QueryState {
  return {
    ...emptyQueryState(),
    ...extra,
    steps: [{ classIri: cls.iri, label: cls.label, props: [] }],
  };
}

/** A two-step "source -> predicate -> target" query for a relationship. */
function twoStep(source: SchemaClass, link: SchemaLink, target: SchemaClass): QueryState {
  return {
    ...emptyQueryState(),
    steps: [
      { classIri: source.iri, label: source.label, props: [] },
      {
        classIri: target.iri,
        label: target.label,
        props: [],
        link: {
          anchor: 0,  // hangs off the source step
          predicates: [{ iri: link.predicate, inverse: false }],
          modifier: "",
          optional: false,
        },
      },
    ],
  };
}

/** Links worth suggesting: real connections, richest first (top 40). */
function rankedLinks(schema: QuerySchema): SchemaLink[] {
  return [...schema.links]
    // Keep only links that occur in data or are formally declared.
    .filter((link) => link.count > 0 || link.declared)
    // Declared first, then by how often they occur.
    .sort((a, b) => Number(b.declared) - Number(a.declared) || b.count - a.count)
    .slice(0, 40);
}

/** Assemble up to `max` starter queries for the loaded ontology. */
export function buildStarters(schema: QuerySchema | null, max = 5): Starter[] {
  if (!schema) return [];
  // Classes that actually have instances, richest first. Sorted here rather
  // than trusting the caller's ordering.
  const populated = schema.classes
    .filter((c) => c.instances > 0)
    .sort((a, b) => b.instances - a.instances || a.label.localeCompare(b.label));
  const starters: Starter[] = [];
  const seen = new Set<string>();

  // Add a starter unless we are full or it duplicates one already added.
  const push = (starter: Starter) => {
    if (starters.length >= max || seen.has(starter.id)) return;
    seen.add(starter.id);
    starters.push(starter);
  };

  // 1. Everything of the most populated type — the simplest useful query.
  const biggest = populated[0];
  if (biggest) {
    push({
      id: `all:${biggest.iri}`,
      title: `All ${pluralTitle(biggest.label)}`,
      detail: `${biggest.instances.toLocaleString()} in this ontology`,
      state: singleStep(biggest),
    });
  }

  // 2. How many of each type — counting questions come first for newcomers.
  if (biggest) {
    push({
      id: `count:${biggest.iri}`,
      title: `How many ${pluralTitle(biggest.label)}?`,
      detail: "Counts rather than rows",
      state: singleStep(biggest, { aggregate: "count" }),
    });
  }

  // 3. SKOS taxonomies: the two questions people actually ask of one.
  const concept = classOf(schema, `${SKOS}Concept`);
  if (concept && concept.instances > 0) {
    const scheme = classOf(schema, `${SKOS}ConceptScheme`);
    push({
      id: "skos:narrower",
      title: "Concepts and their narrower concepts",
      detail: "Walks the hierarchy downwards",
      state: {
        ...emptyQueryState(),
        steps: [
          { classIri: concept.iri, label: concept.label, props: [] },
          {
            classIri: concept.iri,
            label: concept.label,
            props: [],
            link: {
              anchor: 0,
              predicates: [{ iri: `${SKOS}broader`, inverse: true }],
              modifier: "",
              optional: false,
            },
          },
        ],
      },
    });
    if (scheme && scheme.instances > 0) {
      push({
        id: "skos:perScheme",
        title: "How many concepts per scheme?",
        detail: "Counts each vocabulary",
        state: {
          ...emptyQueryState(),
          aggregate: "count",
          steps: [
            { classIri: scheme.iri, label: scheme.label, props: [] },
            {
              classIri: concept.iri,
              label: concept.label,
              props: [],
              link: {
                anchor: 0,
                predicates: [{ iri: `${SKOS}inScheme`, inverse: true }],
                modifier: "",
                optional: false,
              },
            },
          ],
        },
      });
    }
  }

  // 4. The richest relationships in the data, as two-step paths.
  for (const link of rankedLinks(schema)) {
    if (starters.length >= max) break;
    const source = classOf(schema, link.source);
    const target = classOf(schema, link.target);
    if (!source || !target) continue;
    if (source.iri.startsWith(SKOS) || target.iri.startsWith(SKOS)) continue;
    push({
      id: `link:${link.source}|${link.predicate}|${link.target}`,
      title: `${source.label} → ${link.label} → ${target.label}`,
      detail: link.count > 0 ? `${link.count.toLocaleString()} in the data` : "Declared in the schema",
      state: twoStep(source, link, target),
    });
  }

  return starters;
}

/** Classes worth offering as a first step, most useful first. */
export function entryPoints(schema: QuerySchema | null, max = 10): SchemaClass[] {
  if (!schema) return [];
  // A class is "connected" if any link touches it — those make better starts.
  const connected = new Set<string>();
  for (const link of schema.links) {
    connected.add(link.source);
    connected.add(link.target);
  }
  // Rank: connected first, then by instance count, then alphabetically.
  return [...schema.classes]
    .sort(
      (a, b) =>
        Number(connected.has(b.iri)) - Number(connected.has(a.iri)) ||
        b.instances - a.instances ||
        a.label.localeCompare(b.label),
    )
    .slice(0, max);
}
